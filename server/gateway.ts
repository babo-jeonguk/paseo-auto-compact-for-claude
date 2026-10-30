import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { Refusal, readable, targetOf, unchanged, type Gateway, type Observation, type DispatchGuard, type ExecutionContext,
  type OperationEvidence } from "./model";
import type { createObserver } from "./observer";
import { bounded, CLEANUP_TIMEOUT_MS, deadlineOf, LIVE_OBSERVATION_MS, observationEndBy, readWithin, SEND_DEADLINE_MS,
  SEND_TIMEOUT_MS } from "./deadline";
import { claudeProvider } from "../shared/providers";
export { claudeProvider } from "../shared/providers";

type Api = PluginHandlerContext["paseo"];
type Agent = NonNullable<Awaited<ReturnType<ReturnType<Api["agents"]["ref"]>["refresh"]>>>["agent"];
type End = PluginLifecycleEvents["agent.turn_ended"];
type Observer = ReturnType<typeof createObserver>;
type TimelineItem = { type: string; status?: string; trigger?: string };
// The completed manual compaction of the /compact command's own turn.
const commandBoundary = (item: TimelineItem, turnId: string | null | undefined, commandTurn: string | null) =>
  item.type === "compaction" && item.status === "completed" && item.trigger === "manual" &&
  commandTurn !== null && turnId === commandTurn;
const RECOVERED = "Recovered matching native completion and command boundary";
const SESSION_RESUME_REQUIRED = "Session must resume after plugin reload; send a message before compacting";
// Unchanged evidence is still checkpointed this often, as a sign of progress.
const CHECKPOINT_INTERVAL_MS = 5_000;
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
  const reopensStalePluginSession = (ref: object) =>
    typeof Reflect.get(ref, "reload") === "function";
  const requiresSessionResume = async (agentId: string, ref: object) => {
    if (!observer || !reopensStalePluginSession(ref)) return false;
    return await observer.ownsCurrentLaunch(agentId) === false;
  };
  async function observation(agent: Agent, providers?: Record<string, unknown>): Promise<Observation> {
    providers ??= (await requireApi().config.get()).config.providers;
    const tokens = agent.lastUsage?.contextWindowUsedTokens;
    let observerUnreadable = false;
    const native = (await observer?.read(agent.id).catch(() => { observerUnreadable = true; return null; }))?.ledger;
    const matched = native?.sessionId === agent.persistence?.sessionId ? native : undefined;
    const permission = agent.pendingPermissions.length > 0 || agent.attentionReason === 'permission';
    const inputIdleSince = agent.status === 'idle' && !agent.activeTurn && !permission &&
      matched && !matched.activeTurns.length && matched.pendingInputs > 0 &&
      matched.compact?.status !== 'running' ? matched.ordinaryEndedAt : null;
    return {
      agentId: agent.id, title: agent.title, workspace: agent.cwd, provider: agent.provider,
      revision: agent.lastUserMessageAt,
      tokens: typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null,
      eligible: claudeProvider(providers, agent.provider) && !agent.archivedAt && !agent.internal &&
        !agent.providerUnavailable && !agent.labels["paseo.parent-agent-id"] && agent.status !== "closed",
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
    };
  }
  const gateway: Gateway = {
    async list() {
      const { config } = await requireApi().config.get();
      const agents: Observation[] = [];
      let cursor: string | undefined;
      do {
        const page = await requireApi().agents.list({ filter: { includeBackground: true },
          page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        agents.push(...await Promise.all(page.entries.map(({ agent }) => observation(agent, config.providers))));
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      } while (cursor);
      return agents;
    },
    async refresh(id) {
      const current = await requireApi().agents.ref(id).refresh();
      return current ? observation(current.agent) : null;
    },
    ...(observer ? {
      automatic: (expected: Observation, guard?: DispatchGuard, execution?: ExecutionContext) => compact(expected.agentId, expected, true, guard, execution),
      readiness: async (expected: Observation, dueAt?: number) => {
        const ref = requireApi().agents.ref(expected.agentId);
        if (await requiresSessionResume(expected.agentId, ref)) return SESSION_RESUME_REQUIRED;
        return observer.readiness(expected, dueAt);
      },
    } : {}),
    compact: (id, expected, execution) => compact(id, expected, false, undefined, execution),
    async inspect(operation) {
      const evidence = operation.evidence;
      if (evidence?.invalidated) return { status: "unknown", detail: "Conversation changed during compaction; no automatic retry" };
      if (!evidence?.native || !observer) return null;
      const native = await observer.receipt(operation.agentId, evidence.native);
      if (native && native.observedAt > deadlineOf(operation)) return null;
      if (native?.status !== "completed") return native;
      if (evidence.boundary && evidence.turnId) return { status: "completed", detail: RECOVERED };
      // History is evidence only when the caller-known message ID pins its turn.
      // A bounded page can miss old work; absence is never proof of non-delivery.
      const page = await requireApi().agents.ref(operation.agentId).timeline.refetch({ limit: 200 });
      const command = page.entries.find(entry => entry.item.type === "user_message" &&
        entry.item.clientMessageId === operation.id);
      if (command?.turnId && page.entries.some(entry => commandBoundary(entry.item, entry.turnId, command.turnId ?? null)))
        return { status: "completed", detail: RECOVERED };
      return null;
    },
  };
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
    let sent = false, armed = false, healthy = true, cancelled = false, superseded = false;
    let boundary = false;
    const evidence: OperationEvidence = {};
    const entry = { turnId: null as string | null, cancel() { cancelled = true; } };
    let subscription: ReturnType<typeof ref.timeline.subscribe> | undefined;
    const endings = new Map<string, End>();
    let saved = "", lastCheckpoint = 0;
    async function checkpoint(force = false) {
      if (!execution) return;
      const value = { ...evidence, ...(entry.turnId ? { turnId: entry.turnId } : {}),
        boundary, invalidated: !healthy || superseded };
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
      // Both bound only when sending may start. Claude admits the compaction
      // for as long as it can still be observed.
      const startBy = Math.min(guard?.expiresAt ?? Infinity, sendBy);
      if (observer) {
        // Paseo 0.14 reopens stale plugin sessions immediately before their next
        // prompt. A /compact prepared against the previous Mod launch would run
        // in the new launch without its request ID, splitting native completion
        // from the durable operation. Wait for an ordinary prompt to perform the
        // reopen; hosts without ref.reload retain the 0.12/0.13 behavior.
        if (await read(requiresSessionResume(agentId, ref)))
          throw new Refusal(SESSION_RESUME_REQUIRED);
        operation = await read(observer.prepare(before, automatic, observationEndBy(sendBy), id));
        const { launchId, generation, sessionId, revision } = operation;
        evidence.native = { id, launchId, generation, sessionId, revision };
        await checkpoint(true);
      } else if (automatic) throw new Refusal("Claude observer unavailable");
      pending.set(agentId, entry);
      completions.set(agentId, event => { if (armed && event.turnId) endings.set(event.turnId, event); });
      subscription = ref.timeline.subscribe(({ event }) => {
        if (!armed) return;
        if (["replacement", "subscription_restored", "error"].includes(event.type)) healthy = false;
        if (event.type !== "timeline") return;
        if (event.item.type === "user_message") {
          if (event.item.clientMessageId === id) entry.turnId = event.turnId ?? null;
          else superseded = true;
        }
        if (commandBoundary(event.item, event.turnId, entry.turnId)) boundary = true;
      });
      await read(subscription.ready);
      const current = readable(await read(gateway.refresh(agentId)));
      // Running out of time or being stopped is not a reading of the session.
      if (!currentWorker() || cancelled || now() > startBy) throw new Error("Send deadline passed or worker stopped before send");
      if (!current?.idle || !unchanged({ revision: before.revision, target: targetOf(before) }, current) ||
          (guard && !await read(guard.allowed())))
        throw new Refusal("Reservation cancelled or session changed before send");
      // Preparation and the last host/policy checks are asynchronous. Recheck
      // ownership at the dispatch boundary so a reload during that interval
      // cannot send a request prepared for the previous observer launch.
      if (await read(requiresSessionResume(agentId, ref)))
        throw new Refusal(SESSION_RESUME_REQUIRED);
      // Durable marker must precede the external side effect. Recovery never
      // resends once this marker exists, even if a crash preceded ref.send.
      evidence.dispatchStartedAt = now();
      await checkpoint(true);
      deadline = now() + live;
      if (!currentWorker() || cancelled)
        return { status: "unknown", detail: "Worker stopped at dispatch boundary; no automatic retry" };
      // No awaited work remains after this ownership read and before send. The
      // durable marker makes a failure here conservative: nothing was sent, but
      // recovery must not assume it is safe to retry after a possible crash.
      if (await read(requiresSessionResume(agentId, ref)))
        return { status: "unknown", detail: "Observer changed at dispatch boundary; no automatic retry" };
      armed = true;
      sent = true;
      const send = ref.send("/compact", { messageId: id });
      // A rejection/timeout may still mean delivery. Inspect evidence until the
      // original deadline; late send rejection is consumed by bounded().
      await bounded(send, Math.min(options.dispatchTimeoutMs ?? SEND_TIMEOUT_MS, deadline - now())).catch(() => {});
      while (currentWorker() && !cancelled) {
        await checkpoint();
        if (!healthy || superseded) return { status: "unknown", detail: "Conversation changed during compaction; no automatic retry" };
        const native = operation ? await read(observer!.receipt(agentId, evidence.native!)) ??
          await read(observer!.result(agentId, operation)) : null;
        if (native && native.status !== "completed") return native;
        const ended = entry.turnId ? endings.get(entry.turnId) : null;
        if (ended && ended.outcome.kind !== "completed")
          return { status: "failed", detail: "Compact turn failed or was cancelled; no automatic retry" };
        if (boundary && (operation ? native?.status === "completed" : ended?.outcome.kind === "completed")) {
          const after = await wait(gateway.refresh(agentId));
          if (after?.sessionId !== before.sessionId)
            return { status: "failed", detail: "Claude session changed during compaction" };
          await checkpoint(true);
          if (!healthy || superseded || !currentWorker())
            return { status: "unknown", detail: "Conversation changed during completion verification; no automatic retry" };
          return { status: "completed", detail: "Compaction completed in the same Claude session" };
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
      await Promise.all([
        operation ? bounded(observer!.cancel(operation, sent), cleanupMs).catch(() => {}) : undefined,
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
    started(_event: PluginLifecycleEvents["agent.turn_started"]) {},
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
