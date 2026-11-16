import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGateway } from "./server/gateway";
import { createScheduler } from "./server/scheduler";
import { createCachedStore, createStore } from "./server/store";
import { createObserver } from "./server/observer";
import { createReporter } from "./server/report";
import { createLifecycleHooks } from "./server/lifecycle";
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
  const lifecycle = createLifecycleHooks(server);
  const settings = server.registerSettings(compactSettings);
  const observer = createObserver();
  const host = createGateway({ observer });
  // Work cut off by shutdown recovers from durable state on next start; see
  // server/report.ts for how its errors are told apart from real ones.
  const reporter = createReporter(message => console.error("[auto-compact-for-claude]", message));
  const report = reporter.report;
  const scheduler = createScheduler({
    store: createCachedStore(createStore()),
    gateway: host.gateway,
    receipts: { remove: observer.removeReceipt, sweep: observer.sweepReceipts },
    settings: async () => {
      const state = await settings.read();
      return state.status === "ready" ? state.values : null;
    },
    onError: report,
  });
  void scheduler.ready.then(() => scheduler.reconcile(host.connected())).catch(report);
  // Reservations come from native ordinary completion, including when Paseo
  // reports a premature turn end during overlapping compaction/input. Turn ends
  // observe one agent, the tick watches reservations and pending operations,
  // and a full safety scan catches anything a missed event left unnoticed.
  const stops = [
    lifecycle.on("agent.turn.before", (event, { paseo }) => {
      host.attach(paseo);
      host.started(event);
      if (!host.ownTurn(event.agent.id, event.turnId))
        void scheduler.invalidate(event.agent.id).catch(report);
    }),
    lifecycle.on("agent.turn.after", (event, { paseo }) => {
      host.attach(paseo);
      if (host.ownTurn(event.agent.id, event.turnId)) {
        host.ended(event);
        return;
      }
      // Paseo 0.13 no longer includes history in this event. Observe native
      // activity instead; the scheduler deduplicates the unchanged activity
      // identity produced by a manual compact on both Paseo 0.12 and 0.13.
      void scheduler.observe({ kind: "agent", agentId: event.agent.id }).catch(report);
    }),
    ...(
      [
        "agent.permission.before",
        "agent.permission.after",
        "agent.archive.after",
        "agent.close.after",
      ] as const
    ).map((name) =>
      lifecycle.on(name, (event, { paseo }) => {
        host.attach(paseo);
        void scheduler.invalidate(event.agent.id).catch(report);
      })
    ),
    lifecycle.on("agent.create.after", (_event, { paseo }) => host.attach(paseo)),
    lifecycle.beforeSessionOpen(async ({ request }, { paseo }) => {
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
  const timer = setInterval(() => {
    // Overlapping ticks are safe: state changes are serialized, the worker never
    // runs one operation twice, and a reservation phase re-checks fresh state.
    // Operation recovery must progress even when native discovery fails/hangs.
    void scheduler.tick(host.connected()).catch(report);
    if (host.connected()) void scheduler.observe({ kind: "periodic" }).catch(report);
  }, 10_000);
  return () => {
    reporter.dispose();
    clearInterval(timer);
    scheduler.stop();
    host.stop();
    for (const stop of stops) stop();
  };
}
