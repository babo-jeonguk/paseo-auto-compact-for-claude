import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createGateway } from "./server/gateway";
import { createScheduler, TICK_INTERVAL_MS } from "./server/scheduler";
import { createCachedStore, createStore } from "./server/store";
import { createStateChanges } from "./server/state-changes";
import { createObserver } from "./server/observer";
import { createDurableWrites } from "./server/durable";
import { createReporter } from "./server/report";
import { claudeProvider } from "./shared/providers";
import {
  compactRpc,
  listRpc,
  operationRpc,
  sessionRpc,
  skipRpc,
  stateChangedSubscription,
  undoSkipRpc,
  toggleRpc,
} from "./shared/rpc";
import { compactSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(compactSettings);
  // One lifetime for every durable write: the state store and the observer.
  const writes = createDurableWrites();
  const observer = createObserver({ writes });
  const host = createGateway({ observer });
  // Work cut off by shutdown recovers from durable state on next start; see
  // server/report.ts for how its errors are told apart from real ones.
  const reporter = createReporter(message => console.error("[auto-compact-for-claude]", message));
  const report = reporter.report;
  // The one path every state save takes also feeds this, so screens hear about
  // changes no matter which part of the plugin saved them.
  const changes = createStateChanges();
  const scheduler = createScheduler({
    store: createCachedStore(createStore(undefined, writes), changes.saved),
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
    server.addHook("agent.turn.before", async (event, { paseo }) => {
      host.attach(paseo);
      host.started(event);
      if (!host.ownTurn(event.agent.id, event.turnId))
        void scheduler.invalidate(event.agent.id).catch(report);
    }),
    server.addHook("agent.turn.after", async (event, { paseo }) => {
      host.attach(paseo);
      if (host.ownTurn(event.agent.id, event.turnId)) {
        host.ended(event);
        return;
      }
      // The event carries no history; observe native activity instead. The
      // scheduler deduplicates the unchanged activity identity a manual compact
      // produces.
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
      server.addHook(name, async (event: { agent: { id: string } }, { paseo }: PluginHookContext) => {
        host.attach(paseo);
        void scheduler.invalidate(event.agent.id).catch(report);
      })
    ),
    server.addHook("agent.create.after", async (_event, { paseo }) => host.attach(paseo)),
    server.addHook("agent.open.before", async ({ request }, { paseo }) => {
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
      // Settings move no saved state, so the store cannot report the change.
      changes.settingsChanged();
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
  // A block body returns undefined: a returned promise would close the
  // subscription as soon as it settled.
  server.handle(stateChangedSubscription, (input, { push, signal }) => {
    changes.subscribe(input, { push, signal });
  });
  const timer = setInterval(() => {
    // Overlapping ticks are safe: state changes are serialized, the worker never
    // runs one operation twice, and a reservation phase re-checks fresh state.
    // Operation recovery must progress even when native discovery fails/hangs.
    void scheduler.tick(host.connected()).catch(report);
    if (host.connected()) void scheduler.observe({ kind: "periodic" }).catch(report);
  }, TICK_INTERVAL_MS);
  return async () => {
    // Paseo asks the plugin to stop, then awaits this cleanup before it closes
    // the process and starts the replacement (SIGTERM 2 s after, SIGKILL 2 s
    // later). Closing first stops new writes; draining last lets a write
    // already issued land before the next instance starts, while a publication
    // that was never issued never happens at all.
    writes.close();
    reporter.dispose();
    clearInterval(timer);
    scheduler.stop();
    changes.stop();
    host.stop();
    // A settings subscription may end asynchronously, after the reporter is
    // disposed; a defect in it is still logged.
    for (const stop of stops) void Promise.resolve(stop()).catch(reporter.teardown);
    await writes.drain();
  };
}
