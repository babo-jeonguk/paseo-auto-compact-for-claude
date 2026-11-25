import assert from "node:assert/strict";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { CleanupScope } from "./scope";

type Handler = (payload: never, context: never) => unknown;

// A Paseo home for the plugin under test. PASEO_HOME points at it until the
// test ends and then goes back to what the other tests in this process read;
// the plugin a test starts on it stops before either.
export async function paseoHome(scope: CleanupScope, prefix: string) {
  const home = await scope.folder(prefix);
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  scope.defer(() => {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
  });
  return home;
}

// A plugin host with only the current registration API. It records each hook,
// RPC and subscription handler the plugin adds, how often each hook's cleanup
// ran, and the plugin's settings listeners, which `settingsChanged()` calls as
// the host does when the settings change.
export function pluginHost() {
  const hooks = new Map<string, { handler: Handler; stops: number }>();
  const handlers = new Map<string, Handler>();
  const settingsListeners = new Set<() => unknown>();
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "loading" }),
      subscribe: (listener: () => unknown) => {
        settingsListeners.add(listener);
        return () => { settingsListeners.delete(listener); };
      },
    }),
    addHook: (name: string, handler: Handler) => {
      assert(!hooks.has(name), `${name} is registered once`);
      const hook = { handler, stops: 0 };
      hooks.set(name, hook);
      return () => { hook.stops++; };
    },
    handle: (contract: { name: string }, handler: Handler) => {
      assert(!handlers.has(contract.name), `${contract.name} is handled once`);
      handlers.set(contract.name, handler);
    },
  } as unknown as PluginServerContext;
  return {
    server,
    hooks,
    hook: <T>(name: string) => hooks.get(name)!.handler as unknown as T,
    handler: <T>(name: string) => handlers.get(name)! as unknown as T,
    settingsChanged() { for (const listener of settingsListeners) void listener(); },
  };
}
