import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { Refusal, type Gateway, type Observation, type DispatchGuard, type ExecutionContext, type OperationEvidence } from "./model";
import type { createObserver } from "./observer";
import { bounded } from "./deadline";
import { claudeProvider } from "../shared/providers";
export { claudeProvider } from "../shared/providers";

type Api = PluginHandlerContext["paseo"];
type Agent = NonNullable<Awaited<ReturnType<ReturnType<Api["agents"]["ref"]>["refresh"]>>>["agent"];
type End = PluginLifecycleEvents["agent.turn_ended"];
type Observer = ReturnType<typeof createObserver>;
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
  async function observation(agent: Agent, providers?: Record<string, unknown>): Promise<Observation> {
    providers ??= (await requireApi().config.get()).config.providers;
    const tokens = agent.lastUsage?.contextWindowUsedTokens;
    const native = (await observer?.read(agent.id))?.ledger;
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
      readiness: (expected: Observation, dueAt?: number) => observer.readiness(expected, dueAt),
    } : {}),
    compact: (id, expected, execution) => compact(id, expected, false, undefined, execution),
    async inspect(operation) {
      const evidence = operation.evidence;
      if (evidence?.invalidated) return { status: "unknown", detail: "Conversation changed during compaction; no automatic retry" };
      if (!evidence?.native || !observer) return null;
      const native = await observer.receipt(operation.agentId, evidence.native);
      if (native && native.observedAt > (operation.deadlineAt ?? Infinity)) return null;
      if (native?.status !== "completed") return native;
      if (evidence.boundary && evidence.turnId)
        return { status: "completed", detail: "Recovered matching native completion and command boundary" };
      // History is evidence only when the caller-known message ID pins its turn.
      // A bounded page can miss old work; absence is never proof of non-delivery.
      const page = await requireApi().agents.ref(operation.agentId).timeline.refetch({ limit: 200 });
      const command = page.entries.find(entry => entry.item.type === "user_message" &&
        entry.item.clientMessageId === operation.id);
      if (command?.turnId && page.entries.some(entry => entry.turnId === command.turnId &&
          entry.item.type === "compaction" && entry.item.status === "completed" && entry.item.trigger === "manual"))
        return { status: "completed", detail: "Recovered matching native completion and command boundary" };
      return null;
    },
  };
  async function compact(agentId: string, expected: Observation | undefined, automatic: boolean,
    guard?: DispatchGuard, execution?: ExecutionContext): ReturnType<Gateway["compact"]> {
    if (busy.has(agentId) || stopped) throw new Error("Compaction already running or plugin stopped");
    busy.add(agentId);
    try { return await dispatch(agentId, expected, automatic, guard, execution); }
    finally { busy.delete(agentId); }
  }
  async function dispatch(agentId: string, expected: Observation | undefined, automatic: boolean,
    guard?: DispatchGuard, execution?: ExecutionContext): ReturnType<Gateway["compact"]> {
    const deadline = Math.min(execution?.deadlineAt ?? Infinity, now() + (options.timeoutMs ?? 120_000));
    const wait = <T>(work: Promise<T>) => bounded(work, deadline - now());
    const currentWorker = () => !stopped && (execution?.current() ?? true) && now() < deadline;
    const ref = requireApi().agents.ref(agentId);
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
      if (!force && serialized === saved && now() - lastCheckpoint < 5_000) return;
      await wait(execution.checkpoint(value));
      saved = serialized; lastCheckpoint = now();
    }
    try {
      const before = await wait(gateway.refresh(agentId));
      if (!before?.sessionId || !before.idle || !before.eligible ||
          (expected && (before.revision !== expected.revision || before.sessionId !== expected.sessionId ||
            before.activityKey !== expected.activityKey)))
        return { status: "failed", detail: "Claude session unavailable, busy or changed" };
      const expiresAt = Math.min(guard?.expiresAt ?? Infinity, deadline);
      if (observer) {
        operation = await wait(observer.prepare(before, automatic, expiresAt, id));
        const { launchId, generation, sessionId, revision } = operation;
        evidence.native = { id, launchId, generation, sessionId, revision };
        await checkpoint(true);
      } else if (automatic) return { status: "failed", detail: "Claude observer unavailable" };
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
        if (event.item.type === "compaction" && event.item.status === "completed" &&
            event.item.trigger === "manual" && entry.turnId !== null && event.turnId === entry.turnId)
          boundary = true;
      });
      await wait(subscription.ready);
      const current = await wait(gateway.refresh(agentId));
      if (!currentWorker() || cancelled || !current?.idle || current.sessionId !== before.sessionId ||
          current.revision !== before.revision || current.activityKey !== before.activityKey ||
          now() > expiresAt || (guard && !await wait(guard.allowed())))
        return { status: "failed", detail: "Reservation cancelled or session changed before send" };
      // Durable marker must precede the external side effect. Recovery never
      // resends once this marker exists, even if a crash preceded ref.send.
      evidence.dispatchStartedAt = now();
      await checkpoint(true);
      if (!currentWorker() || cancelled)
        return { status: "unknown", detail: "Worker stopped at dispatch boundary; no automatic retry" };
      armed = true;
      sent = true;
      const send = ref.send("/compact", { messageId: id });
      // A rejection/timeout may still mean delivery. Inspect evidence until the
      // original deadline; late send rejection is consumed by bounded().
      await bounded(send, Math.min(options.dispatchTimeoutMs ?? 30_000, deadline - now())).catch(() => {});
      while (currentWorker() && !cancelled) {
        await checkpoint();
        if (!healthy || superseded) return { status: "unknown", detail: "Conversation changed during compaction; no automatic retry" };
        const native = operation ? await wait(observer!.receipt?.(agentId, evidence.native!) ?? Promise.resolve(null)) ??
          await wait(observer!.result(agentId, operation)) : null;
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
      // Retrying is the worker's decision; report a fault rather than an outcome.
      if (!(error instanceof Refusal)) throw error;
      return { status: "failed", detail: `Compaction stopped before send: ${error.message}` };
    } finally {
      armed = false;
      if (pending.get(agentId) === entry) {
        completions.delete(agentId);
        pending.delete(agentId);
      }
      const cleanupMs = options.cleanupTimeoutMs ?? 1_000;
      await Promise.all([
        operation ? bounded(observer!.cancel(operation, sent), cleanupMs).catch(() => {}) : undefined,
        subscription ? bounded(Promise.resolve(subscription.release()), cleanupMs).catch(() => {}) : undefined,
      ]);
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
