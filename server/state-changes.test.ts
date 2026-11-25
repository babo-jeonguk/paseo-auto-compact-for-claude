import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import contribute from "../index.server";
import { stateChangedSubscription, toggleRpc } from "../shared/rpc";
import type { Job, State, StoredOperation } from "./model";
import { changedConversations } from "./state-changes";
import { cleanupScope } from "../tests/support/scope";
import { drainer } from "../tests/support/drained";
import { paseoHome, pluginHost } from "../tests/support/plugin-host";

type Event = { agentId: string | null; revision: number };
type Subscribe = (input: { agentId?: string },
  context: { paseo: unknown; signal: AbortSignal; push(event: Event): Promise<void> }) => unknown;
type Toggle = (input: { agentId: string; enabled: boolean }, context: { paseo: unknown }) => Promise<{ changed: boolean }>;
const paseo = {};

// The plugin started on its own Paseo home and the real state store, with the
// host's view of its handlers. `stop()` stops it the way the host does, once.
async function plugin(t: TestContext, prefix: string) {
  const scope = cleanupScope(t);
  await paseoHome(scope, prefix);
  const drained = drainer();
  const host = pluginHost();
  const stopPlugin = contribute(host.server);
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await stopPlugin(); } };
  scope.defer(stop);
  const toggle = (agentId: string, enabled: boolean) =>
    host.handler<Toggle>(toggleRpc.name)({ agentId, enabled }, { paseo });
  // A subscriber as the host connects one: the events it pushed, in order,
  // each checked against the contract the client parses them with.
  const subscribe = (input: { agentId?: string } = {}) => {
    const events: Event[] = [];
    const controller = new AbortController();
    const result = host.handler<Subscribe>(stateChangedSubscription.name)(input, {
      paseo, signal: controller.signal,
      push: async event => { events.push(stateChangedSubscription.event.parse(event)); },
    });
    return { events, result, abort: () => controller.abort() };
  };
  return { host, toggle, subscribe, stop, drained };
}

test("a new subscription first asks its screen to read everything, and stays open until its signal aborts", async (t) => {
  const f = await plugin(t, "compact-subscribe-");
  const subscriber = f.subscribe();
  // A returned promise would close the subscription when it settles.
  assert.equal(subscriber.result, undefined);
  assert.equal(subscriber.events.length, 1);
  assert.equal(subscriber.events[0].agentId, null);
  // The host replays nothing missed while disconnected; a subscription made
  // again after a reconnect asks again.
  const again = f.subscribe();
  assert.deepEqual(again.events.map(event => event.agentId), [null]);
});

test("a save that changes a conversation pushes exactly one event for it; a save that changes nothing it shows pushes none", async (t) => {
  const f = await plugin(t, "compact-subscribe-save-");
  const subscriber = f.subscribe();
  assert.deepEqual(await f.toggle("a", false), { changed: true });
  assert.deepEqual(subscriber.events.slice(1).map(event => event.agentId), ["a"]);
  assert(subscriber.events[1].revision > subscriber.events[0].revision, "each event moves the revision on");
  // Saved again with the same switch: nothing a screen shows changed.
  assert.deepEqual(await f.toggle("a", false), { changed: true });
  assert.equal(subscriber.events.length, 2);
  assert.deepEqual(await f.toggle("a", true), { changed: true });
  assert.deepEqual(subscriber.events.slice(2).map(event => event.agentId), ["a"]);
  assert(subscriber.events[2].revision > subscriber.events[1].revision);
});

test("a subscription narrowed to one conversation ignores the others but hears that settings changed", async (t) => {
  const f = await plugin(t, "compact-subscribe-narrow-");
  const subscriber = f.subscribe({ agentId: "b" });
  await f.toggle("a", false);
  assert.equal(subscriber.events.length, 1);
  await f.toggle("b", false);
  assert.deepEqual(subscriber.events.slice(1).map(event => event.agentId), ["b"]);
  f.host.settingsChanged();
  assert.deepEqual(subscriber.events.slice(2).map(event => event.agentId), [null]);
});

test("an aborted subscription hears nothing more, and a stopped plugin leaves nothing running for its subscribers", async (t) => {
  const f = await plugin(t, "compact-subscribe-end-");
  const ended = f.subscribe(), open = f.subscribe();
  ended.abort();
  await f.toggle("a", false);
  assert.equal(ended.events.length, 1);
  assert.deepEqual(open.events.slice(1).map(event => event.agentId), ["a"]);
  await f.stop();
  // The host aborts what is still open once the plugin has stopped.
  open.abort();
  await f.drained();
  assert.equal(open.events.length, 2);
});

const job = (agentId: string, changes: Partial<Job> = {}): Job => ({
  agentId, revision: "r1", endedAt: 1_000, status: "scheduled", detail: "Scheduled", ...changes,
});
const operation = (agentId: string, changes: Partial<StoredOperation> = {}): StoredOperation => ({
  id: `op-${agentId}`, agentId, revision: "r1", target: { sessionId: "s", activityKey: "k" }, kind: "manual",
  state: "observing", createdAt: 1_000, updatedAt: 1_000, result: null, inputFingerprint: "f", owner: "w1",
  attempt: 0, evidence: { dispatchStartedAt: 1_100 }, ...changes,
});
const state = (changes: Partial<State> = {}): State =>
  ({ version: 1, disabled: [], jobs: [job("a"), job("b")], operations: [operation("a")], ...changes });

test("a change is narrowed to the conversations whose shown state it changes", () => {
  assert.equal(changedConversations(null, state()), null, "without the state it replaced, everything may have changed");
  assert.deepEqual(changedConversations(state(), state()), []);
  assert.deepEqual(changedConversations(state(), state({ disabled: ["b"] })), ["b"]);
  assert.deepEqual(changedConversations(state({ disabled: ["b"] }), state()), ["b"]);
  assert.deepEqual(changedConversations(state(), state({ jobs: [job("a"), job("b", { status: "skipped" })] })), ["b"]);
  assert.deepEqual(changedConversations(state(), state({ jobs: [job("a")] })), ["b"]);
  assert.deepEqual(changedConversations(state(), state({ operations: [operation("a", { state: "succeeded" })] })), ["a"]);
  assert.deepEqual(changedConversations(state(), state({ operations: [operation("a", {
    result: { code: "completed", message: "Compacted" } })] })), ["a"]);
  assert.deepEqual(changedConversations(state(), state({ operations: [operation("a"), operation("b")] })), ["b"]);
  assert.deepEqual(changedConversations(state(), state({ operations: [] })), ["a"]);
  // Progress the worker saves while it works is not shown.
  assert.deepEqual(changedConversations(state(), state({ operations: [operation("a", {
    updatedAt: 2_000, owner: "w2", attempt: 1, nextAttemptAt: 3_000,
    evidence: { dispatchStartedAt: 1_100, turnId: "t", boundary: true } })] })), []);
  assert.deepEqual(changedConversations(state(), state({ disabled: ["b", "a"], jobs: [job("a", { detail: "Other" }), job("b")] })),
    ["a", "b"]);
});
