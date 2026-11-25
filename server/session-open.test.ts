import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { PluginHookEvents, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { cleanupScope } from "../tests/support/scope";
import { paseoHome, pluginHost } from "../tests/support/plugin-host";

type Before = (input: { request: PluginSessionOpenRequest }, context: unknown) => Promise<PluginSessionOpenRequest>;

// Every hook the plugin registers. Each one has its current name; the
// deprecated `on` and `before` names are announced for removal upstream.
const HOOKS = ["agent.turn.before", "agent.turn.after", "agent.permission.before", "agent.permission.after",
  "agent.archive.after", "agent.close.after", "agent.create.after", "agent.open.before"];

test("plugin state or observer failures cannot prevent a Claude session from opening", async (t) => {
  const scope = cleanupScope(t);
  const home = await paseoHome(scope, "compact-session-open-");
  t.mock.method(console, "error", () => {});
  const { server, hook } = pluginHost();
  const data = join(home, "plugin-data", "auto-compact-for-claude");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "state.json"), "{ corrupt");
  scope.defer(contribute(server));
  const open = hook<Before>("agent.open.before");
  const request = { agentId: "a", workspaceId: "w", provider: "claude",
    purpose: "interactive", reason: "create", cwd: home, title: "Conversation",
    labels: { retained: "yes" }, metadata: {}, background: false, tools: [], mcpServers: {},
    env: { CLAUDE_CODE_PLUGIN_DIRS: "/existing" } } as PluginSessionOpenRequest;
  const paseo = { config: { get: async () => ({ config: { providers: {} } }) } };
  const opened = await open({ request }, { paseo });
  const dirs = opened.env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter);
  assert.equal(dirs[0], "/existing");
  assert.match(dirs[1], /observers/);
  // An observer that cannot be written leaves the session unchanged rather than closed.
  await rm(join(data, "observers"), { recursive: true });
  await writeFile(join(data, "observers"), "not a directory");
  assert.deepEqual(await open({ request }, { paseo }), request);
});

test("turn-ended hooks use native activity without reading the deprecated timeline snapshot", async (t) => {
  const scope = cleanupScope(t);
  const home = await paseoHome(scope, "compact-empty-timeline-");
  const { server, hook } = pluginHost();
  scope.defer(contribute(server));
  type Ended = PluginHookEvents["agent.turn.after"];
  const ended = hook<(event: Ended, context: unknown) => Promise<void>>("agent.turn.after");
  // The payload the host sends, including the fields the SDK requires.
  const event: Ended = {
    agent: { id: "a", provider: "claude", cwd: home, title: null,
      parentAgentId: null, workspaceId: "w", background: false, metadata: {} },
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
  await ended(event, { paseo });
  await observing;
  assert.equal(timelineRead, false, "turn_ended.timeline must not be read");
});

test("the plugin registers every hook through addHook under its current name and removes each one on stop", async (t) => {
  const scope = cleanupScope(t);
  await paseoHome(scope, "compact-hooks-");
  const { server, hooks } = pluginHost();
  // Stop is deferred first, so a failed check below still stops the plugin.
  let stopped = false;
  const stop = contribute(server);
  scope.defer(() => { if (!stopped) stop(); });
  assert.deepEqual([...hooks.keys()].sort(), [...HOOKS].sort());
  stop();
  stopped = true;
  assert.deepEqual([...hooks.values()].map(hook => hook.stops), HOOKS.map(() => 1));
});

test("a hook the host refuses to register fails the plugin's start", async (t) => {
  const scope = cleanupScope(t);
  await paseoHome(scope, "compact-hook-refused-");
  t.mock.method(console, "error", () => {});
  const { server } = pluginHost();
  const refused = new Error("host rejected registration");
  server.addHook = () => { throw refused; };
  assert.throws(() => contribute(server), error => error === refused);
});
