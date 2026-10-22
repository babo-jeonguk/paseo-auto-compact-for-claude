import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import type { Gateway, Observation, DispatchGuard } from "./model";
import type { createObserver } from "./observer";
import { claudeProvider } from "../shared/providers";
export { claudeProvider } from "../shared/providers";

type Api = PluginHandlerContext["paseo"];
type Agent = NonNullable<Awaited<ReturnType<ReturnType<Api["agents"]["ref"]>["refresh"]>>>["agent"];
type End = PluginLifecycleEvents["agent.turn_ended"];
type Observer = ReturnType<typeof createObserver>;
export function createGateway(options: {
  observer?: Observer; now?: () => number; timeoutMs?: number; pollMs?: number;
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
      activityKey: matched && matched.ordinaryRevision !== null && matched.ordinaryRevision === matched.revision
        ? `${matched.launchId}:${matched.generation}:${matched.ordinaryRevision}` : null,
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
      automatic: (expected: Observation, guard?: DispatchGuard) => compact(expected.agentId, expected, true, guard),
      readiness: (expected: Observation, dueAt?: number) => observer.readiness(expected, dueAt),
    } : {}),
    compact: (id, expected) => compact(id, expected, false),
  };
  async function compact(agentId: string, expected: Observation | undefined, automatic: boolean,
    guard?: DispatchGuard): ReturnType<Gateway["compact"]> {
    if (busy.has(agentId) || stopped) return { status: "failed", detail: "Compaction already running or plugin stopped" };
    busy.add(agentId);
    try { return await dispatch(agentId, expected, automatic, guard); }
    finally { busy.delete(agentId); }
  }
  async function dispatch(agentId: string, expected: Observation | undefined, automatic: boolean,
    guard?: DispatchGuard): ReturnType<Gateway["compact"]> {
    const ref = requireApi().agents.ref(agentId);
    const before = await gateway.refresh(agentId);
    if (!before?.sessionId || !before.idle || !before.eligible ||
        (expected && (before.revision !== expected.revision || before.sessionId !== expected.sessionId ||
          before.activityKey !== expected.activityKey)))
      return { status: "failed", detail: "Claude session unavailable, busy or changed" };
    const expiresAt = Math.min(guard?.expiresAt ?? Infinity, now() + (options.timeoutMs ?? 120_000));
    let operation: Awaited<ReturnType<Observer['prepare']>> | undefined;
    if (observer) {
      try { operation = await observer.prepare(before, automatic, expiresAt); }
      catch (error) { return { status: "failed", detail: (error as Error).message }; }
    } else if (automatic) return { status: "failed", detail: "Claude observer unavailable" };
    const id = operation?.id ?? randomUUID();
    let sent = false;
    let armed = false, healthy = true, cancelled = false, superseded = false;
    let boundary = false, ended: End | null = null;
    const entry = { turnId: null as string | null, cancel() { cancelled = true; } };
    pending.set(agentId, entry);
    let subscription: ReturnType<typeof ref.timeline.subscribe> | undefined;
    // Lifecycle completion is secondary evidence only. Native PostCompact and a
    // new boundary on our message's turn are required when the observer is loaded.
    const endings = new Map<string, End>();
    const finish = (event: End) => { if (event.turnId) endings.set(event.turnId, event); };
    completions.set(agentId, finish);
    try {
      subscription = ref.timeline.subscribe(({ event }) => {
      if (["replacement", "subscription_restored", "error"].includes(event.type)) healthy = false;
      if (!armed || event.type !== "timeline") return;
      if (event.item.type === "user_message") {
        if (event.item.clientMessageId === id) entry.turnId = event.turnId ?? null;
        else superseded = true;
      }
      if (event.item.type === "compaction" && event.item.status === "completed" &&
          event.item.trigger === "manual" && entry.turnId !== null && event.turnId === entry.turnId)
        boundary = true;
    });
      await subscription.ready;
      const current = await gateway.refresh(agentId);
      if (stopped || cancelled || !current?.idle || current.sessionId !== before.sessionId ||
          current.revision !== before.revision || current.activityKey !== before.activityKey ||
          now() > expiresAt || (guard && !await guard.allowed()))
        return { status: "failed", detail: "Reservation cancelled or session changed before send" };
      armed = true;
      sent = true;
      await ref.send("/compact", { messageId: id });
      const finishBy = now() + (options.timeoutMs ?? 120_000);
      while (now() <= finishBy && !stopped && !cancelled) {
        if (!healthy || superseded) return { status: "unknown", detail: "Conversation changed during compaction; no automatic retry" };
        const native = operation ? await observer!.result(agentId, operation) : null;
        if (native && native.status !== "completed") return native;
        ended = entry.turnId ? endings.get(entry.turnId) ?? null : null;
        if (ended && ended.outcome.kind !== "completed")
          return { status: "failed", detail: "Compact turn failed or was cancelled; no automatic retry" };
        if (boundary && (operation ? native?.status === "completed" : ended?.outcome.kind === "completed")) {
          const after = await gateway.refresh(agentId);
          if (after?.sessionId !== before.sessionId)
            return { status: "failed", detail: "Claude session changed during compaction" };
          return { status: "completed", detail: "Compaction completed in the same Claude session" };
        }
        await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 50));
      }
      return { status: "unknown", detail: "Compaction completion unconfirmed; no automatic retry" };
    } finally {
      completions.delete(agentId);
      pending.delete(agentId);
      if (operation) await observer!.cancel(operation, sent).catch(() => {});
      await subscription?.release();
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
