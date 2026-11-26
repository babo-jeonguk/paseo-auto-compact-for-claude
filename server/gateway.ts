import type { PluginHandlerContext, PluginHookEvents } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { Refusal, readable, targetOf, unchanged, type Gateway, type Observation, type DispatchGuard, type ExecutionContext,
  type LeftoverDecision, type OperationEvidence, type StoredOperation } from "./model";
import type { createObserver } from "./observer";
import { bounded, CLEANUP_TIMEOUT_MS, deadlineOf, LIVE_OBSERVATION_MS, observationEndBy, pause, readWithin, SEND_DEADLINE_MS,
  SEND_TIMEOUT_MS, Stopped, systemTimers, type Timers } from "./deadline";
import { claudeProvider } from "../shared/providers";
import { SESSION_RESUME_REQUIRED } from "../shared/rpc";
export { claudeProvider } from "../shared/providers";

type Api = PluginHandlerContext["paseo"];
type Agent = NonNullable<Awaited<ReturnType<ReturnType<Api["agents"]["ref"]>["refresh"]>>>["agent"];
type End = PluginHookEvents["agent.turn.after"];
type Observer = ReturnType<typeof createObserver>;
type TimelineItem = { type: string; status?: string; trigger?: string; clientMessageId?: string };
// The completed manual compaction of the /compact command's own turn.
const commandBoundary = (item: TimelineItem, turnId: string | null | undefined, commandTurn: string | null) =>
  item.type === "compaction" && item.status === "completed" && item.trigger === "manual" &&
  commandTurn !== null && turnId === commandTurn;
// What a history page proves about the /compact sent with message ID `id`.
// History is evidence only when that caller-known ID pins the command's turn;
// a bounded page can miss old work, so a missing command (null) is never proof
// of non-delivery. Other input around the command proves nothing either way:
// Paseo 0.16.2 and later deliver a steered message after the compaction, and
// any input that did stop it shows as Claude's failure or the turn's outcome.
function pinnedCommand(entries: ReadonlyArray<{ turnId?: string | null; item: TimelineItem }>, id: string) {
  const turnId = entries.find(entry => entry.item.type === "user_message" && entry.item.clientMessageId === id)?.turnId ?? null;
  if (turnId === null) return null;
  return { turnId, boundary: entries.some(entry => commandBoundary(entry.item, entry.turnId, turnId)) };
}
// The SDK's lost live view: after a reconnect (`subscription_restored`) history
// may have been missed, a `replacement` invalidates the previous timeline epoch,
// and an `error` releases the subscription. None of them says the conversation
// changed; they say the live events no longer show everything that happened.
const LOST_VIEW = new Set(["subscription_restored", "replacement", "error"]);
const RECOVERED = "Recovered matching native completion and command boundary";
// Unchanged evidence is still checkpointed this often, as a sign of progress.
const CHECKPOINT_INTERVAL_MS = 5_000;
// After a lost live view, history is read at most this often while completion
// is awaited: a 200-entry page on every 50 ms poll would load the host for
// nothing, and a second is small next to the two-minute live observation.
const HISTORY_REFETCH_INTERVAL_MS = 1_000;
// Between checks for completion evidence after sending. A check reads the
// observer's local files and remembered live events, so polling often costs
// little and notices completion soon after Claude reports it.
export const EVIDENCE_POLL_MS = 50;
export function createGateway(options: {
  observer?: Observer; now?: () => number; timers?: Timers; timeoutMs?: number; pollMs?: number; dispatchTimeoutMs?: number;
  cleanupTimeoutMs?: number;
} = {}) {
  const { observer } = options;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? systemTimers;
  const pending = new Map<string, { turnId: string | null }>();
  const busy = new Set<string>();
  // One writer of a conversation's native request at a time: a turn ends with
  // its last write, not with the wait on it.
  const writers = new Map<string, { done: Promise<void>; end: () => void }>();
  const takeTurn = (agentId: string) => {
    const earlier = writers.get(agentId)?.done ?? Promise.resolve();
    let end!: () => void;
    const own = new Promise<void>(resolve => { end = resolve; });
    const turn = { done: earlier.then(() => own), end };
    writers.set(agentId, turn);
    // Drop the entry once this chain has ended, unless a newer turn replaced it.
    void turn.done.then(() => { if (writers.get(agentId) === turn) writers.delete(agentId); });
    return { wait: earlier, end };
  };
  // Stopping the gateway aborts this signal, which ends every wait on it at
  // once, cleanup waits included, and clears their timers.
  const stopping = new AbortController();
  let api: Api | null = null;
  let stopped = false;
  const requireApi = () => {
    if (!api) throw new Error("Waiting for a conversation lifecycle event or plugin request");
    return api;
  };
  // Paseo reopens a stale plugin session immediately before its next prompt. A
  // /compact prepared against the previous Mod launch would run in the new
  // launch without its request ID, splitting native completion from the durable
  // operation.
  const staleLaunch = (agentId: string, launchId: string) =>
    !!observer && !observer.startedHere(agentId, launchId);
  async function observation(agent: Agent, providers?: Record<string, unknown>): Promise<Observation> {
    providers ??= (await requireApi().config.get()).config.providers;
    const tokens = agent.lastUsage?.contextWindowUsedTokens;
    const eligible = claudeProvider(providers, agent.provider) && !agent.archivedAt && !agent.internal &&
      agent.background !== true &&
      !agent.providerUnavailable && !agent.labels["paseo.parent-agent-id"] && agent.status !== "closed";
    let observerUnreadable = false;
    const native = (eligible
      ? await observer?.read(agent.id).catch(() => { observerUnreadable = true; return null; }) : null)?.ledger;
    const matched = native?.sessionId === agent.persistence?.sessionId ? native : undefined;
    const permission = agent.pendingPermissions.length > 0 || agent.attentionReason === 'permission';
    const inputIdleSince = agent.status === 'idle' && !agent.activeTurn && !permission &&
      matched && !matched.activeTurns.length && matched.pendingInputs > 0 &&
      matched.compact?.status !== 'running' ? matched.ordinaryEndedAt : null;
    return {
      agentId: agent.id, title: agent.title, workspace: agent.cwd, provider: agent.provider,
      revision: agent.lastUserMessageAt,
      tokens: typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null,
      eligible,
      idle: agent.status === "idle" && !agent.activeTurn && agent.pendingPermissions.length === 0 &&
        agent.attentionReason !== "permission" && (!matched ||
          (!matched.activeTurns.length && !matched.pendingInputs && matched.compact?.status !== "running")),
      busyReason: permission ? 'permission' : matched?.pendingInputs ? 'input' : 'reply',
      inputIdleSince,
      sessionId: agent.persistence?.sessionId ?? null,
      // Compaction consumes the ordinary scheduling window, but is still an
      // attempt for that native activity. Keep its identity even when Paseo
      // advances lastUserMessageAt for /compact and ordinaryRevision is cleared.
      activityKey: matched && (matched.ordinaryRevision === matched.revision ||
          matched.compact?.revision === matched.revision)
        ? `${matched.launchId}:${matched.generation}:${matched.revision}` : null,
      observedEndedAt: matched?.ordinaryEndedAt ?? null,
      cache: matched?.cache ?? null,
      ...(observerUnreadable ? { observerUnreadable } : {}),
      ...(native && staleLaunch(agent.id, native.launchId) ? { resumeRequired: true } : {}),
    };
  }
  const gateway: Gateway = {
    async list(observe) {
      const { config } = await requireApi().config.get();
      let cursor: string | undefined;
      do {
        const page = await requireApi().agents.list({ filter: { includeBackground: true },
          page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        // Observations run while later pages are listed. The caller handles
        // each one from the moment it starts; until then a rejection must not
        // count as unhandled.
        for (const { agent } of page.entries) {
          const observed = observation(agent, config.providers);
          observed.catch(() => {});
          observe(observed);
        }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      } while (cursor);
    },
    async refresh(id) {
      const current = await requireApi().agents.ref(id).refresh();
      return current ? observation(current.agent) : null;
    },
    ...(observer ? {
      automatic: (expected: Observation, guard: DispatchGuard | undefined, execution: ExecutionContext) =>
        compact(expected.agentId, expected, true, guard, execution),
      readiness: (expected: Observation, dueAt?: number) => observer.readiness(expected, dueAt),
      async release(operation: StoredOperation) {
        const native = operation.evidence?.native;
        if (!native) return;
        const turn = takeTurn(operation.agentId);
        await turn.wait;
        try {
          await observer.release(operation.agentId, native, operation.evidence?.dispatchStartedAt !== undefined);
        } finally {
          turn.end();
        }
      },
      // Startup retires what an earlier instance left prepared, as the
      // scheduler's leftover decision says; each conversation's failure is the
      // scheduler's to report.
      recover: async (decide: LeftoverDecision, report: (error: unknown) => void) =>
        observer.recoverPrepared(decide, report),
    } : {}),
    compact: (id, expected, execution) => compact(id, expected, false, undefined, execution),
    async inspect(operation) {
      const evidence = operation.evidence;
      // Set when the observer changed at the dispatch boundary, and by releases
      // that still treated later input as a change; neither can complete now.
      if (evidence?.invalidated) return { status: "unknown", detail: "Compaction evidence no longer attributable; no automatic retry" };
      if (!evidence?.native || !observer) return null;
      const native = await observer.receipt(operation.agentId, evidence.native);
      if (native && native.observedAt > deadlineOf(operation)) return null;
      if (native?.status !== "completed") return native;
      if (evidence.boundary && evidence.turnId) return { status: "completed", detail: RECOVERED };
      return (await history(operation.agentId, operation.id))?.boundary ? { status: "completed", detail: RECOVERED } : null;
    },
  };
  const history = async (agentId: string, id: string) =>
    pinnedCommand((await requireApi().agents.ref(agentId).timeline.refetch({ limit: 200 })).entries, id);
  async function compact(agentId: string, expected: Observation | undefined, automatic: boolean,
    guard: DispatchGuard | undefined, execution: ExecutionContext): ReturnType<Gateway["compact"]> {
    if (stopped) throw new Error("Plugin stopped");
    // A concurrent dispatch of this conversation is a condition, not a fault.
    if (busy.has(agentId)) throw new Refusal("Compaction already running for this conversation");
    // `timeoutMs` is the live-observation budget only. Until the dispatch marker
    // the send deadline applies; after it a fresh observation budget, so a late
    // send is still observed in full.
    const live = options.timeoutMs ?? LIVE_OBSERVATION_MS;
    const sendBy = execution?.sendBy ?? now() + SEND_DEADLINE_MS[automatic ? "automatic" : "manual"];
    let deadline = sendBy;
    const wait = <T>(work: Promise<T>) => bounded(work, deadline - now(), timers, execution.fault, stopping.signal);
    const read = <T>(work: Promise<T>) => readWithin(work, deadline, now(), timers, execution.fault, stopping.signal);
    const currentWorker = () => !stopped && (execution?.current() ?? true) && now() < deadline;
    const ref = requireApi().agents.ref(agentId);
    busy.add(agentId);
    const id = execution?.id ?? randomUUID();
    let operation: Awaited<ReturnType<Observer['prepare']>> | undefined;
    let preparing: ReturnType<Observer['prepare']> | undefined;
    let turn: ReturnType<typeof takeTurn> | undefined;
    let sent = false, armed = false, ownershipLost = false;
    let boundary = false;
    // Lost live views so far. After one, the live command turn and boundary
    // prove nothing on their own; `pinned` holds what history read since the
    // last loss shows, and is cleared by every new loss.
    let losses = 0, lastRefetch = -Infinity;
    let pinned: { turnId: string; boundary: boolean } | null = null;
    const proof = () => losses ? { turnId: pinned?.turnId ?? null, boundary: !!pinned?.boundary }
      : { turnId: entry.turnId, boundary };
    const evidence: OperationEvidence = {};
    const entry = { turnId: null as string | null };
    let subscription: ReturnType<typeof ref.timeline.subscribe> | undefined;
    const endings = new Map<string, End>();
    let saved = "", lastCheckpoint = 0;
    async function checkpoint(force = false) {
      if (!execution) return;
      const { turnId, boundary } = proof();
      // A lost live view is not a change: the evidence stays valid, so
      // reconciliation keeps checking it until the observation deadline.
      const value = { ...evidence, ...(turnId ? { turnId } : {}), boundary, invalidated: ownershipLost };
      const serialized = JSON.stringify(value);
      if (!force && serialized === saved && now() - lastCheckpoint < CHECKPOINT_INTERVAL_MS) return;
      await wait(execution.checkpoint(value));
      saved = serialized; lastCheckpoint = now();
    }
    try {
      if (observer) {
        turn = takeTurn(agentId);
        await read(turn.wait);
      }
      const before = readable(await read(gateway.refresh(agentId)));
      if (!before?.sessionId || !before.idle || !before.eligible ||
          (expected && !unchanged({ revision: expected.revision, target: targetOf(expected) }, before)))
        throw new Refusal("Claude session unavailable, busy or changed");
      if (before.resumeRequired) throw new Refusal(SESSION_RESUME_REQUIRED);
      // Both bound only when sending may start. Claude admits the compaction
      // for as long as it can still be observed.
      const startBy = Math.min(guard?.expiresAt ?? Infinity, sendBy);
      if (observer) {
        preparing = observer.prepare(before, automatic, observationEndBy(sendBy), id);
        operation = await read(preparing);
        const { launchId, generation, sessionId, revision } = operation;
        // The preparation names this exact request, so a receipt from another
        // preparation of the same operation cannot settle it.
        evidence.native = { id, launchId, generation, sessionId, revision,
          ...(operation.preparation ? { preparation: operation.preparation } : {}) };
        await checkpoint(true);
      } else if (automatic) throw new Refusal("Claude observer unavailable");
      pending.set(agentId, entry);
      completions.set(agentId, event => { if (armed && event.turnId) endings.set(event.turnId, event); });
      subscription = ref.timeline.subscribe(({ event }) => {
        if (!armed) return;
        if (LOST_VIEW.has(event.type)) { losses++; pinned = null; }
        if (event.type !== "timeline") return;
        // Only the command's own message pins its turn; other input is not evidence.
        if (event.item.type === "user_message" && event.item.clientMessageId === id) entry.turnId = event.turnId ?? null;
        if (commandBoundary(event.item, event.turnId, entry.turnId)) boundary = true;
      });
      await read(subscription.ready);
      const current = readable(await read(gateway.refresh(agentId)));
      // Running out of time is a fault the worker retries until the send
      // deadline; before then, a worker that is no longer current has stopped.
      if (now() > startBy || now() >= deadline) throw new Error("Send deadline passed before send");
      if (stopped || !execution.current()) throw new Stopped();
      if (!current?.idle || !unchanged({ revision: before.revision, target: targetOf(before) }, current) ||
          (guard && !await read(guard.allowed())))
        throw new Refusal("Reservation cancelled or session changed before send");
      if (current.resumeRequired) throw new Refusal(SESSION_RESUME_REQUIRED);
      // Durable marker must precede the external side effect. Recovery never
      // resends once this marker exists, even if a crash preceded ref.send.
      evidence.dispatchStartedAt = now();
      await checkpoint(true);
      deadline = now() + live;
      if (!currentWorker())
        return { status: "unknown", detail: "Worker stopped at dispatch boundary; no automatic retry" };
      // The host may have reopened the session while the marker was written.
      // This check is in memory and cannot fail, and nothing is awaited after
      // it before the send. Nothing was sent, but the marker exists, and a
      // marker means "may have sent" to everything that reads it later, so the
      // outcome is the conservative unknown.
      // Invalidating the evidence ends it at once instead of after observation.
      if (operation && staleLaunch(agentId, operation.launchId)) {
        ownershipLost = true;
        await checkpoint(true).catch(() => {});
        return { status: "unknown", detail: "Observer changed at dispatch boundary; no automatic retry" };
      }
      armed = true;
      sent = true;
      const send = ref.send("/compact", { messageId: id });
      // A rejection/timeout may still mean delivery. Inspect evidence until the
      // original deadline; late send rejection is consumed by bounded().
      await bounded(send, Math.min(options.dispatchTimeoutMs ?? SEND_TIMEOUT_MS, deadline - now()), timers, execution.fault,
        stopping.signal)
        .catch(() => {});
      while (currentWorker()) {
        await checkpoint();
        const native = operation ? await read(observer!.receipt(agentId, evidence.native!)) ??
          await read(observer!.result(agentId, operation)) : null;
        if (native && native.status !== "completed") return native;
        // With an observer, history is only worth reading once Claude reports
        // completion; without one, the command turn's end is the other half.
        if (losses && (!operation || native?.status === "completed") &&
            now() - lastRefetch >= HISTORY_REFETCH_INTERVAL_MS) {
          lastRefetch = now();
          const at = losses;
          // A failed or late read is evidence of nothing; the next poll reads again.
          const found = await wait(history(agentId, id)).catch(() => null);
          // A page read across another loss may belong to the replaced epoch, so
          // it pins neither a turn nor a boundary. The next poll reads history again.
          if (found && losses === at) pinned = found;
        }
        const { turnId, boundary: proven } = proof();
        const ended = turnId ? endings.get(turnId) : null;
        if (ended && ended.outcome.kind !== "completed")
          return { status: "failed", detail: "Compact turn failed or was cancelled; no automatic retry" };
        if (proven && (operation ? native?.status === "completed" : ended?.outcome.kind === "completed")) {
          const at = losses;
          const after = await wait(gateway.refresh(agentId));
          if (after?.sessionId !== before.sessionId)
            return { status: "failed", detail: "Claude session changed during compaction" };
          await checkpoint(true);
          if (!currentWorker())
            return { status: "unknown", detail: "Worker stopped during completion verification; no automatic retry" };
          // A view lost during verification voids the proof read before it; the
          // next poll proves the command's turn and boundary again from history.
          if (losses === at) return { status: "completed", detail: "Compaction completed in the same Claude session" };
        }
        // The next check, or the deadline if it comes first; the loop then ends.
        await pause(Math.min(options.pollMs ?? EVIDENCE_POLL_MS, deadline - now()), timers, stopping.signal);
      }
      return { status: "unknown", detail: "Compaction completion unconfirmed; no automatic retry" };
    } catch (error) {
      if (sent) return { status: "unknown", detail: "Compaction completion unconfirmed; no automatic retry" };
      // Before sending, refusals and faults alike are the worker's to classify.
      throw error;
    } finally {
      armed = false;
      if (pending.get(agentId) === entry) {
        completions.delete(agentId);
        pending.delete(agentId);
      }
      const cleanupMs = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
      // A preparation that outlives the wait on it is still retired once it
      // lands while the plugin runs; the cleanup wait bounds waiting, it does
      // not cancel the work. The turn ends with those writes, however late.
      // Once the plugin's durable writes have closed (it stopped after dispatch),
      // the retirement is refused and the next instance's startup recovery
      // retires the request, so a restarting query can still attribute its refusal.
      const prepared = operation !== undefined ? Promise.resolve(operation) : preparing;
      const retire = prepared && !(sent && stopped)
        ? prepared.then(value => observer!.cancel(value, sent), () => undefined)
        : undefined;
      const writes = retire ?? prepared;
      if (turn) {
        if (writes) void writes.then(turn.end, turn.end);
        else turn.end();
      }
      await Promise.all([
        retire ? bounded(retire, cleanupMs, timers, execution.fault, stopping.signal).catch(() => {}) : undefined,
        subscription ? bounded(Promise.resolve(subscription.release()), cleanupMs, timers, execution.fault, stopping.signal)
          .catch(() => {}) : undefined,
      ]);
      busy.delete(agentId);
    }
  }
  const completions = new Map<string, (event: End) => void>();
  return {
    gateway,
    attach(value: Api) { api = value; },
    connected: () => api !== null,
    ownTurn(agentId: string, turnId: string | null) {
      return turnId !== null && pending.get(agentId)?.turnId === turnId;
    },
    started(_event: PluginHookEvents["agent.turn.before"]) {},
    ended(event: End) { completions.get(event.agent.id)?.(event); },
    stop() {
      stopped = true;
      stopping.abort();
    },
    async providers() {
      const current = requireApi();
      const [{ entries }, { config }] = await Promise.all([
        current.providers.snapshot(),
        current.config.get(),
      ]);
      return entries
        .filter((entry) => claudeProvider(config.providers, entry.provider))
        .map((entry) => ({
          id: entry.provider,
          label: entry.label ?? entry.provider,
        }));
    },
  };
}
