import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGateway } from "./server/gateway";
import { createScheduler } from "./server/scheduler";
import { bounded, INSPECT_TIMEOUT_MS } from "./server/deadline";
import { createStore } from "./server/store";
import { createObserver } from "./server/observer";
import { claudeProvider } from "./shared/providers";
import {
  compactRpc,
  listRpc,
  operationRpc,
  sessionRpc,
  skipRpc,
  undoSkipRpc,
  toggleRpc,
} from "./shared/rpc";
import { compactSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(compactSettings);
  const observer = createObserver();
  const host = createGateway({ observer });
  // Paseo closes this plugin's API just before calling the cleanup below, so work in
  // flight then fails with a closed client. Everything after cleanup starts is such
  // cut-off work: its durable state recovers on next start, and a defect in that
  // work would also be reported outside shutdown.
  let disposed = false;
  const report = (error: unknown) => {
    if (!disposed) console.error("[auto-compact-for-claude]", String(error));
  };
  const scheduler = createScheduler({
    store: createStore(),
    gateway: host.gateway,
    receipts: { remove: observer.removeReceipt, sweep: observer.sweepReceipts },
    settings: async () => {
      const state = await settings.read();
      return state.status === "ready" ? state.values : null;
    },
    onError: report,
  });
  void scheduler.ready.then(() => scheduler.reconcile(host.connected())).catch(report);
  // Reservations are created from native ordinary completion, including when
  // Paseo reports a premature turn end during overlapping compaction/input.
  const observe = async () => {
    if (!host.connected()) return;
    for (const agent of await bounded(host.gateway.list(), INSPECT_TIMEOUT_MS)) {
      if (agent.activityKey && agent.observedEndedAt !== null && agent.observedEndedAt !== undefined)
        await scheduler.observedTurn(agent, agent.observedEndedAt);
    }
  };
  const stops = [
    server.on("agent.turn_started", (event, { paseo }) => {
      host.attach(paseo);
      host.started(event);
      if (!host.ownTurn(event.agent.id, event.turnId))
        void scheduler.invalidate(event.agent.id).catch(report);
    }),
    server.on("agent.turn_ended", (event, { paseo }) => {
      host.attach(paseo);
      if (host.ownTurn(event.agent.id, event.turnId)) {
        host.ended(event);
        return;
      }
      // Paseo 0.13 no longer includes history in this event. Observe native
      // activity instead; the scheduler deduplicates the unchanged activity
      // identity produced by a manual compact on both Paseo 0.12 and 0.13.
      void observe().catch(report);
    }),
    ...(
      [
        "agent.permission_requested",
        "agent.permission_resolved",
        "agent.archived",
        "agent.closed",
      ] as const
    ).map((name) =>
      server.on(name, (event, { paseo }) => {
        host.attach(paseo);
        void scheduler.invalidate(event.agent.id).catch(report);
      })
    ),
    server.on("agent.created", (_event, { paseo }) => host.attach(paseo)),
    server.before("agent.session_open", async ({ request }, { paseo }) => {
      host.attach(paseo);
      // Plugin failures must not keep a conversation from opening; without an
      // observer the controls ask the user to reopen the session.
      if (request.purpose === "interactive")
        await scheduler.invalidate(request.agentId).catch(report);
      // Add a Claude Mod to this session's environment; never rewrite provider
      // commands or configure, discover, adopt or share another plugin's runtime.
      try {
        const { config } = await paseo.config.get();
        return await observer.prepareSession(request, claudeProvider(config.providers, request.provider));
      } catch (error) {
        report(error);
        return request;
      }
    }),
    settings.subscribe(() => {
      void scheduler.tick(host.connected()).catch(report);
    }),
  ];
  server.handle(sessionRpc, async ({ agentId }, { paseo }) => {
    host.attach(paseo);
    return { row: await scheduler.session(agentId) };
  });
  server.handle(listRpc, async (_input, { paseo }) => {
    host.attach(paseo);
    return {
      rows: await scheduler.list(),
      providers: await host.providers(),
      automaticDispatch: true,
    };
  });
  server.handle(toggleRpc, async ({ agentId, enabled }, { paseo }) => {
    host.attach(paseo);
    return { changed: await scheduler.toggle(agentId, enabled) };
  });
  server.handle(skipRpc, async ({ agentId, revision }, { paseo }) => {
    host.attach(paseo);
    return { changed: await scheduler.skip(agentId, revision) };
  });
  server.handle(undoSkipRpc, async ({ agentId, revision, skipId }, { paseo }) => {
    host.attach(paseo);
    return { changed: await scheduler.undoSkip(agentId, revision, skipId) };
  });
  server.handle(compactRpc, async ({ agentId, revision, operationId, target }, { paseo }) => {
    host.attach(paseo);
    return scheduler.compactNow(agentId, revision, operationId, target);
  });
  server.handle(operationRpc, async ({ operationId }, { paseo }) => {
    host.attach(paseo);
    return { operation: await scheduler.operation(operationId) };
  });
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    // Operation recovery must progress even when native discovery fails/hangs.
    void scheduler.tick(host.connected()).catch(report).finally(() => { ticking = false; });
    void observe().catch(report);
  }, 10_000);
  return () => {
    disposed = true;
    clearInterval(timer);
    scheduler.stop();
    host.stop();
    for (const stop of stops) stop();
  };
}
