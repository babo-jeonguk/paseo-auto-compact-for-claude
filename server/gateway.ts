import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { LifecycleEvents } from "./lifecycle";
import { randomUUID } from "node:crypto";
import { Refusal, readable, targetOf, unchanged, type Gateway, type Observation, type DispatchGuard, type ExecutionContext,
  type OperationEvidence, type StoredOperation } from "./model";
import type { createObserver } from "./observer";
import { bounded, CLEANUP_TIMEOUT_MS, deadlineOf, LIVE_OBSERVATION_MS, observationEndBy, readWithin, SEND_DEADLINE_MS,
  SEND_TIMEOUT_MS } from "./deadline";
import { claudeProvider } from "../shared/providers";
import { SESSION_RESUME_REQUIRED } from "../shared/rpc";
export { claudeProvider } from "../shared/providers";

type Api = PluginHandlerContext["paseo"];
type Agent = NonNullable<Awaited<ReturnType<ReturnType<Api["agents"]["ref"]>["refresh"]>>>["agent"];
type End = LifecycleEvents["agent.turn.after"];
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
export function createGateway(options: {
  observer?: Observer; now?: () => number; timeoutMs?: number; pollMs?: number; dispatchTimeoutMs?: number; cleanupTimeoutMs?: number;
} = {}) {
  const { observer } = options;
  const now = options.now ?? Date.now;
  const pending = new Map<string, { turnId: string | null; cancel(): void }>();
  const busy = new Set<string>();
  let api: Api | null = null;
  let stopped = false;
  const requireApi = () => {
    if (!api) throw new Error("Waiting for a conversation lifecycle event or plugin request");
    return api;
  };
  // Paseo 0.14 reopens a stale plugin session immediately before its next
  // prompt. A /compact prepared against the previous Mod launch would run in
  // the new launch without its request ID, splitting native completion from
  // the durable operation. Hosts without ref.reload keep the 0.12/0.13 behavior.
  const reopensStaleSessions = (agentId: string) =>
    typeof Reflect.get(requireApi().agents.ref(agentId), "reload") === "function";
  const staleLaunch = (agentId: string, launchId: string, reopens = reopensStaleSessions(agentId)) =>
    !!observer && reopens && !observer.startedHere(agentId, launchId);
  async function observation(agent: Agent, providers?: Record<string, unknown>): Promise<Observation> {
    providers ??= (await requireApi().config.get()).config.providers;
    const tokens = agent.lastUsage?.contextWindowUsedTokens;
    const eligible = claudeProvider(providers, agent.provider) && !agent.archivedAt && !agent.internal &&
      (agent as { readonly background?: boolean }).background !== true &&
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
      automatic: (expected: Observation, guard?: DispatchGuard, execution?: ExecutionContext) => compact(expected.agentId, expected, true, guard, execution),
      readiness: (expected: Observation, dueAt?: number) => observer.readiness(expected, dueAt),
      async release(operation: StoredOperation) {
        const native = operation.evidence?.native;
        if (native) await observer.release(operation.agentId, native, operation.evidence?.dispatchStartedAt !== undefined);
      },
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
    guard?: DispatchGuard, execution?: ExecutionContext): ReturnType<Gateway["compact"]> {
    if (stopped) throw new Error("Plugin stopped");
    // A concurrent dispatch of this conversation is a condition, not a fault.
    if (busy.has(agentId)) throw new Refusal("Compaction already running for this conversation");
    // `timeoutMs` is the live-observation budget only. Until the dispatch marker
    // the send deadline applies; after it a fresh observation budget, so a late
    // send is still observed in full.
    const live = options.timeoutMs ?? LIVE_OBSERVATION_MS;
    const sendBy = execution?.sendBy ?? now() + SEND_DEADLINE_MS[automatic ? "automatic" : "manual"];
    let deadline = sendBy;
    const wait = <T>(work: Promise<T>) => bounded(work, deadline - now());
    const read = <T>(work: Promise<T>) => readWithin(work, deadline, now());
    const currentWorker = () => !stopped && (execution?.current() ?? true) && now() < deadline;
    const ref = requireApi().agents.ref(agentId);
    busy.add(agentId);
    const id = execution?.id ?? randomUUID();
    let operation: Awaited<ReturnType<Observer['prepare']>> | undefined;
    let sent = false, armed = false, cancelled = false, ownershipLost = false;
    let boundary = false;
    // Lost live views so far. After one, the live command turn and boundary
    // prove nothing on their own; `pinned` holds what history read since the
    // last loss shows, and is cleared by every new loss.
    let losses = 0, lastRefetch = -Infinity;
    let pinned: { turnId: string; boundary: boolean } | null = null;
    const proof = () => losses ? { turnId: pinned?.turnId ?? null, boundary: !!pinned?.boundary }
      : { turnId: entry.turnId, boundary };
    const evidence: OperationEvidence = {};
    const entry = { turnId: null as string | null, cancel() { cancelled = true; } };
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
      const before = readable(await read(gateway.refresh(agentId)));
      if (!before?.sessionId || !before.idle || !before.eligible ||
          (expected && !unchanged({ revision: expected.revision, target: targetOf(expected) }, before)))
        throw new Refusal("Claude session unavailable, busy or changed");
      if (before.resumeRequired) throw new Refusal(SESSION_RESUME_REQUIRED);
      // Both bound only when sending may start. Claude admits the compaction
      // for as long as it can still be observed.
      const startBy = Math.min(guard?.expiresAt ?? Infinity, sendBy);
      const reopens = reopensStaleSessions(agentId);
      if (observer) {
        operation = await read(observer.prepare(before, automatic, observationEndBy(sendBy), id));
        const { launchId, generation, sessionId, revision } = operation;
        evidence.native = { id, launchId, generation, sessionId, revision };
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
      // Running out of time or being stopped is not a reading of the session.
      if (!currentWorker() || cancelled || now() > startBy) throw new Error("Send deadline passed or worker stopped before send");
      if (!current?.idle || !unchanged({ revision: before.revision, target: targetOf(before) }, current) ||
          (guard && !await read(guard.allowed())))
        throw new Refusal("Reservation cancelled or session changed before send");
      if (current.resumeRequired) throw new Refusal(SESSION_RESUME_REQUIRED);
      // Durable marker must precede the external side effect. Recovery never
      // resends once this marker exists, even if a crash preceded ref.send.
      evidence.dispatchStartedAt = now();
      await checkpoint(true);
      deadline = now() + live;
      if (!currentWorker() || cancelled)
        return { status: "unknown", detail: "Worker stopped at dispatch boundary; no automatic retry" };
      // The host may have reopened the session while the marker was written.
      // With `reopens` read above this check is in memory and cannot fail, and
      // nothing is awaited after it before the send. Nothing was sent, but the
      // marker exists, and a marker means "may have sent" to everything that
      // reads it later, so the outcome is the conservative unknown.
      // Invalidating the evidence ends it at once instead of after observation.
      if (operation && staleLaunch(agentId, operation.launchId, reopens)) {
        ownershipLost = true;
        await checkpoint(true).catch(() => {});
        return { status: "unknown", detail: "Observer changed at dispatch boundary; no automatic retry" };
      }
      armed = true;
      sent = true;
      const send = ref.send("/compact", { messageId: id });
      // A rejection/timeout may still mean delivery. Inspect evidence until the
      // original deadline; late send rejection is consumed by bounded().
      await bounded(send, Math.min(options.dispatchTimeoutMs ?? SEND_TIMEOUT_MS, deadline - now())).catch(() => {});
      while (currentWorker() && !cancelled) {
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
        await wait(new Promise(resolve => setTimeout(resolve, options.pollMs ?? 50)));
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
      // When the plugin stops after dispatch, leave the prepared request intact
      // so a restarting query can still attribute its refusal; the next instance's
      // reconciliation retires it once the operation settles.
      await Promise.all([
        operation && !(sent && stopped) ? bounded(observer!.cancel(operation, sent), cleanupMs).catch(() => {}) : undefined,
        subscription ? bounded(Promise.resolve(subscription.release()), cleanupMs).catch(() => {}) : undefined,
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
    started(_event: LifecycleEvents["agent.turn.before"]) {},
    ended(event: End) { completions.get(event.agent.id)?.(event); },
    stop() { stopped = true; for (const entry of pending.values()) entry.cancel(); },
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
