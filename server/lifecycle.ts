import type {
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";

// Keep the payload types available in our minimum SDK. The beta's aliases have
// the same payloads, so business handlers need no version-specific branches.
const legacyNames = {
  "agent.turn.before": "agent.turn_started",
  "agent.turn.after": "agent.turn_ended",
  "agent.permission.before": "agent.permission_requested",
  "agent.permission.after": "agent.permission_resolved",
  "agent.archive.after": "agent.archived",
  "agent.close.after": "agent.closed",
  "agent.create.after": "agent.created",
} as const satisfies Record<string, keyof PluginLifecycleEvents>;

export type LifecycleEvents = {
  [Name in keyof typeof legacyNames]: PluginLifecycleEvents[(typeof legacyNames)[Name]];
};
type Registration = Pick<PluginServerContext, "on" | "before">;
type OpenHandler = (
  input: { request: PluginSessionOpenRequest },
  context: PluginHookContext,
) => PluginSessionOpenRequest | void | Promise<PluginSessionOpenRequest | void>;

// Only this runtime capability boundary needs a structural type: SDK 0.12 does
// not declare addHook. Public methods below constrain the names and payloads.
type AddHook = (
  this: Registration,
  name: keyof LifecycleEvents | "agent.open.before",
  handler: (input: never, context: PluginHookContext) => Promise<unknown>,
) => () => void;

export function createLifecycleHooks(server: Registration) {
  const capability: unknown = Reflect.get(server, "addHook");
  const addHook = typeof capability === "function" ? capability as AddHook : null;
  return {
    on<Name extends keyof LifecycleEvents>(
      name: Name,
      handler: (event: PluginLifecycleEvents[(typeof legacyNames)[Name]], context: PluginHookContext) => void | Promise<void>,
    ) {
      if (addHook)
        return addHook.call(server, name, async (event: PluginLifecycleEvents[(typeof legacyNames)[Name]], context) => handler(event, context));
      return server.on<(typeof legacyNames)[Name]>(legacyNames[name], handler);
    },
    beforeSessionOpen(handler: OpenHandler) {
      if (addHook)
        return addHook.call(server, "agent.open.before", async (input: { request: PluginSessionOpenRequest }, context) => handler(input, context));
      return server.before("agent.session_open", handler);
    },
  };
}
