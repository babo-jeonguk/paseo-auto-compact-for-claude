import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { cleanupScope, type CleanupScope } from "../tests/support/scope";

type Before = (input: { request: PluginSessionOpenRequest }, context: unknown) => Promise<PluginSessionOpenRequest>;

// A Paseo home for the plugin under test. PASEO_HOME points at it until the
// test ends and then goes back to what the other tests in this process read;
// the plugin a test starts on it stops before either.
async function paseoHome(scope: CleanupScope, prefix: string) {
  const home = await scope.folder(prefix);
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  scope.defer(() => {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
  });
  return home;
}

test("plugin state or observer failures cannot prevent a Claude session from opening", async (t) => {
  const scope = cleanupScope(t);
  const home = await paseoHome(scope, "compact-session-open-");
  t.mock.method(console, "error", () => {});
  let open: Before | undefined;
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "loading" }), subscribe: () => () => {} }),
    on: () => () => {},
    before: (name: string, handler: Before) => {
      if (name === "agent.session_open") open = handler;
      return () => {};
    },
    handle: () => {},
  } as unknown as PluginServerContext;
  const data = join(home, "plugin-data", "auto-compact-for-claude");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "state.json"), "{ corrupt");
  scope.defer(contribute(server));
  const request = { agentId: "a", workspaceId: "w", provider: "claude",
    purpose: "interactive", reason: "create", cwd: home, title: "Conversation",
    labels: { retained: "yes" }, metadata: {}, background: false, tools: [], mcpServers: {},
    env: { CLAUDE_CODE_PLUGIN_DIRS: "/existing" } } as PluginSessionOpenRequest;
  const paseo = { config: { get: async () => ({ config: { providers: {} } }) } };
  const opened = await open!({ request }, { paseo });
  const dirs = opened.env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter);
  assert.equal(dirs[0], "/existing");
  assert.match(dirs[1], /observers/);
  // An observer that cannot be written leaves the session unchanged rather than closed.
  await rm(join(data, "observers"), { recursive: true });
  await writeFile(join(data, "observers"), "not a directory");
  assert.deepEqual(await open!({ request }, { paseo }), request);
});

test("turn-ended hooks use native activity without reading the deprecated timeline snapshot", async (t) => {
  const scope = cleanupScope(t);
  const home = await paseoHome(scope, "compact-empty-timeline-");
  let ended: ((event: unknown, context: unknown) => void) | undefined;
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "loading" }), subscribe: () => () => {} }),
    on: (name: string, handler: (event: unknown, context: unknown) => void) => {
      if (name === "agent.turn_ended") ended = handler;
      return () => {};
    },
    before: () => () => {},
    handle: () => {},
  } as unknown as PluginServerContext;
  scope.defer(contribute(server));
  const event = {
    agent: { id: "a", provider: "claude", cwd: home, title: null,
      parentAgentId: null, workspaceId: "w" },
    turnId: "ordinary-1",
    outcome: { kind: "completed" },
  };
  let timelineRead = false;
  Object.defineProperty(event, "timeline", {
    get() { timelineRead = true; throw new Error("turn_ended.timeline must not be read"); },
  });
  // The hook passes only the conversation's ID on to an observation, which
  // reads the host; by then the event is no longer in reach.
  let observed!: () => void;
  const observing = new Promise<void>(resolve => { observed = resolve; });
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
      ref: () => ({ refresh: async () => { observed(); return null; } }),
    },
  };
  assert.doesNotThrow(() => ended!(event, { paseo }));
  await observing;
  assert.equal(timelineRead, false, "turn_ended.timeline must not be read");
});
