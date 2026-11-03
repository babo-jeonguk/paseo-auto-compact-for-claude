import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginHookContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { createLifecycleHooks } from "./lifecycle";

const names = [
  ["agent.turn.before", "agent.turn_started"],
  ["agent.turn.after", "agent.turn_ended"],
  ["agent.permission.before", "agent.permission_requested"],
  ["agent.permission.after", "agent.permission_resolved"],
  ["agent.archive.after", "agent.archived"],
  ["agent.close.after", "agent.closed"],
  ["agent.create.after", "agent.created"],
] as const;
const context = { signal: new AbortController().signal, paseo: {} } as PluginHookContext;
const request: PluginSessionOpenRequest = {
  ...{
    agentId: "a", workspaceId: null, cwd: "/work", provider: "claude",
    purpose: "interactive" as const, reason: "resume" as const, env: { OTHER_PLUGIN: "keep" },
    title: null, labels: {}, tools: [], mcpServers: {},
  },
};

function fixture(modern: boolean) {
  const calls: Array<{ kind: string; name: string; handler: (...args: never[]) => unknown; stops: number }> = [];
  const register = (receiver: unknown, kind: string, name: string, handler: (...args: never[]) => unknown) => {
    assert.equal(receiver, server, "registration preserves the host method receiver");
    const call = { kind, name, handler, stops: 0 }; calls.push(call);
    return () => { call.stops++; };
  };
  const server = {
    on(this: unknown, name: string, handler: (...args: never[]) => unknown) { return register(this, "on", name, handler); },
    before(this: unknown, name: string, handler: (...args: never[]) => unknown) { return register(this, "before", name, handler); },
    addHook: modern ? function (this: unknown, name: string, handler: (...args: never[]) => unknown) {
      return register(this, "addHook", name, handler);
    } : undefined,
  };
  const hooks = createLifecycleHooks(server as unknown as Parameters<typeof createLifecycleHooks>[0]);
  return { calls, server, hooks, invoke: (at: number, payload: unknown) => Reflect.apply(calls[at].handler, undefined, [payload, context]) };
}

for (const modern of [false, true]) {
  test(`${modern ? "new" : "legacy"} host registers each notification once and forwards its payload and context`, async () => {
    const f = fixture(modern), stops: Array<() => void> = [];
    let seen = 0;
    const payload = { agent: { id: "a" }, turnId: "turn-a" };
    for (const [name] of names) stops.push(f.hooks.on(name, (event, ctx) => {
      assert.equal(event, payload); assert.equal(ctx, context); seen++;
    }));
    assert.deepEqual(f.calls.map(call => [call.kind, call.name]),
      names.map(([current, legacy]) => [modern ? "addHook" : "on", modern ? current : legacy]));
    for (let i = 0; i < names.length; i++) {
      const result = f.invoke(i, payload);
      if (modern) assert(result instanceof Promise, "new hooks require async handlers");
      await result;
    }
    assert.equal(seen, names.length);
    stops.forEach(stop => stop()); assert(f.calls.every(call => call.stops === 1));
  });

  test(`${modern ? "new" : "legacy"} session-open hook preserves an awaited replacement request, extra fields and env`, async () => {
    const f = fixture(modern), extended = { ...request, futureHostField: { value: "other-plugin-data" } };
    const replacement = { ...extended, env: { ...extended.env, OBSERVER: "added" } };
    const stop = f.hooks.beforeSessionOpen(async (input, ctx) => {
      await Promise.resolve(); assert.equal(input.request, extended); assert.equal(ctx, context);
      return replacement;
    });
    assert.deepEqual(f.calls.map(call => [call.kind, call.name]),
      [[modern ? "addHook" : "before", modern ? "agent.open.before" : "agent.session_open"]]);
    assert.equal(await f.invoke(0, { request: extended }), replacement);
    stop(); assert.equal(f.calls[0].stops, 1);
  });
}

test("a new-hook rejection propagates without registering or executing a legacy fallback", async () => {
  const f = fixture(true), error = new Error("hook failed");
  f.hooks.on("agent.turn.after", () => { throw error; });
  await assert.rejects(f.invoke(0, {}) as Promise<unknown>, candidate => candidate === error);
  f.hooks.beforeSessionOpen(async () => { throw error; });
  await assert.rejects(f.invoke(1, { request }) as Promise<unknown>, candidate => candidate === error);
  assert.deepEqual(f.calls.map(call => call.kind), ["addHook", "addHook"]);
});

test("a new-hook registration failure is not retried through the legacy API", () => {
  const f = fixture(true), error = new Error("host rejected registration");
  f.server.addHook = () => { throw error; };
  const hooks = createLifecycleHooks(f.server as unknown as Parameters<typeof createLifecycleHooks>[0]);
  assert.throws(() => hooks.on("agent.turn.before", () => {}), candidate => candidate === error);
  assert.deepEqual(f.calls, []);
});

test("a non-function addHook property uses the legacy API and void open results stay void", async () => {
  const f = fixture(false);
  Object.assign(f.server, { addHook: "not a capability" });
  const hooks = createLifecycleHooks(f.server as unknown as Parameters<typeof createLifecycleHooks>[0]);
  hooks.beforeSessionOpen(() => {});
  assert.equal(await f.invoke(0, { request }), undefined);
  assert.equal(f.calls[0].kind, "before");
});
