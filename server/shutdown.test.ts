import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDurableWrites, type DurableFiles } from "./durable";
import { createScheduler } from "./scheduler";
import { createCachedStore, createStore } from "./store";
import type { Gateway, Observation, State } from "./model";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { HISTORY_RETENTION_MS } from "./retention";
import { cleanupScope, type CleanupScope } from "../tests/support/scope";
import { drainer } from "../tests/support/drained";
import { fakeTimers } from "../tests/support/timers";
import { heldFiles } from "../tests/support/files";
import { paseoHome, pluginHost } from "../tests/support/plugin-host";
import contribute from "../index.server";
import { createHash } from "node:crypto";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";

// A plugin reload under one daemon: the host stops the old instance, which
// closes its durable writes and drains them, and starts the next one only once
// that has ended. These tests play that handoff with two instances on one
// state file and check what the next instance finds and keeps.
const agent: Observation = { agentId: "a", title: null, workspace: "/work", provider: "claude",
  revision: new Date(1_000_000).toISOString(), tokens: 210_000, eligible: true, idle: true, sessionId: "native-a" };
const native = { id: "op", launchId: "launch", generation: "generation", sessionId: "native-a", revision: 1 };

function instance(scope: CleanupScope, path: string, files?: DurableFiles, gateway: Partial<Gateway> = {},
  onError?: (error: unknown) => void, options: Partial<Parameters<typeof createScheduler>[0]> = {}) {
  const writes = createDurableWrites(files);
  const scheduler = createScheduler({
    store: createCachedStore(createStore(path, writes)),
    gateway: { list: async () => {}, refresh: async () => structuredClone(agent),
      compact: async () => ({ status: "completed", detail: "done" }), ...gateway },
    settings: async () => ({ ...DEFAULT_SETTINGS }),
    now: () => 1_000_000,
    timers: fakeTimers(),
    onError,
    ...options,
  });
  scope.defer(() => scheduler.stop());
  // What the plugin's cleanup does: close the writes, stop, then drain.
  const stop = () => { writes.close(); scheduler.stop(); return writes.drain(); };
  return { writes, scheduler, stop };
}
const stored = async (path: string): Promise<State> => JSON.parse(await readFile(path, "utf8"));

test("a state write already issued when the plugin stops lands before the next instance starts", async (t) => {
  const scope = cleanupScope(t);
  const path = join(await scope.folder("compact-shutdown-"), "state.json");
  const { files, holdRename } = heldFiles();
  const old = instance(scope, path, files);
  await old.scheduler.ready;
  const held = holdRename(path);
  void old.scheduler.toggle("old", false).catch(() => {});
  await held.reached;
  let stopped = false;
  const stopping = old.stop().then(() => { stopped = true; });
  await drainer()();
  assert.equal(stopped, false, "stopping waits for the issued rename");
  held.release();
  await stopping;
  const next = instance(scope, path);
  await next.scheduler.ready;
  await next.scheduler.toggle("new", false);
  assert.deepEqual((await stored(path)).disabled.sort(), ["new", "old"]);
});

test("a state write not yet published when the plugin stops is never published", async (t) => {
  const scope = cleanupScope(t);
  const path = join(await scope.folder("compact-shutdown-"), "state.json");
  const { files, holdWrite } = heldFiles();
  const old = instance(scope, path, files);
  await old.scheduler.ready;
  const held = holdWrite(path);
  void old.scheduler.toggle("old", false).catch(() => {});
  await held.reached;
  const stopping = old.stop();
  held.release();
  await stopping;
  assert.deepEqual((await stored(path)).disabled, [], "the fenced write left the file as it was");
  const next = instance(scope, path);
  await next.scheduler.ready;
  await next.scheduler.toggle("new", false);
  assert.deepEqual((await stored(path)).disabled, ["new"]);
});

for (const phase of ["issued", "unpublished"] as const) {
  test(`a worker checkpoint ${phase === "issued" ? "already issued" : "not yet published"} when the plugin stops cannot replace the next instance's state`, async (t) => {
    const scope = cleanupScope(t);
    const path = join(await scope.folder("compact-shutdown-"), "state.json");
    const { files, holdRename, holdWrite } = heldFiles();
    let held: ReturnType<typeof holdWrite> | undefined;
    let reach!: () => void;
    const reached = new Promise<void>(resolve => { reach = resolve; });
    const old = instance(scope, path, files, {
      compact: async (_agentId, _expected, execution) => {
        held = phase === "issued" ? holdRename(path) : holdWrite(path);
        void held.reached.then(reach);
        await execution!.checkpoint({ native: { ...native, id: execution!.id } }).catch(() => {});
        return { status: "unknown", detail: "stopped" };
      },
    });
    await old.scheduler.ready;
    const accepted = await old.scheduler.compactNow("a", agent.revision!, "op");
    assert.equal(accepted.status, "running");
    await reached;
    const stopping = old.stop();
    held!.release();
    await stopping;
    const next = instance(scope, path);
    await next.scheduler.ready;
    await next.scheduler.toggle("new", false);
    const state = await stored(path);
    assert.deepEqual(state.disabled, ["new"], "the next instance's change is kept");
    const operation = state.operations.find(entry => entry.id === "op")!;
    if (phase === "issued") assert.equal(operation.evidence?.native?.id, "op", "the issued checkpoint landed before the handoff");
    else assert.equal(operation.evidence?.native, undefined, "the fenced checkpoint was never published");
  });
}

test("at startup, requests an earlier instance left prepared are retired against the stored operations", async (t) => {
  const scope = cleanupScope(t);
  const path = join(await scope.folder("compact-shutdown-"), "state.json");
  const operation = (id: string, state: State["operations"][number]["state"], marked: boolean, preparation?: string) => ({
    id, agentId: "a", revision: agent.revision!, target: { sessionId: "native-a", activityKey: null }, kind: "manual",
    state, createdAt: 1, updatedAt: 1, inputFingerprint: null, sendBy: 2_000_000,
    result: ["requested", "dispatching", "observing"].includes(state) ? null : { code: "unknown", message: "ended" },
    evidence: { native: { ...native, id, ...(preparation ? { preparation } : {}) }, ...(marked ? { dispatchStartedAt: 999_000 } : {}) },
  });
  await writeFile(path, JSON.stringify({ version: 1, disabled: [], jobs: [], operations: [
    operation("observed", "observing", true, "p"), operation("unsent", "dispatching", false, "p"),
    operation("finished", "unknown", true, "p") ] }));
  const decisions = new Map<string, unknown>();
  let recovered!: () => void;
  const recovery = new Promise<void>(resolve => { recovered = resolve; });
  const next = instance(scope, path, undefined, {
    recover: async decide => {
      for (const id of ["observed", "unsent", "finished", "missing"]) decisions.set(id, decide({ id, preparation: "p" }));
      recovered();
    },
  });
  await next.scheduler.ready;
  await recovery;
  assert.deepEqual(Object.fromEntries(decisions), {
    observed: null, unsent: { sent: false }, finished: { sent: true }, missing: { sent: false },
  });
});

test("startup recovery decides against the operations left after history cleanup", async (t) => {
  const scope = cleanupScope(t);
  const path = join(await scope.folder("compact-shutdown-"), "state.json");
  const now = 1_000_000 + HISTORY_RETENTION_MS + 1;
  // Finished and sent long enough ago that startup's history cleanup removes it.
  await writeFile(path, JSON.stringify({ version: 1, disabled: [], jobs: [], operations: [{
    id: "old", agentId: "a", revision: agent.revision!, target: { sessionId: "native-a", activityKey: null },
    kind: "manual", state: "unknown", createdAt: 1, updatedAt: 1, inputFingerprint: null, sendBy: 2,
    result: { code: "unknown", message: "ended" },
    evidence: { native: { ...native, id: "old", preparation: "p" }, dispatchStartedAt: 1 } }] }));
  let decided!: (decision: unknown) => void;
  const decision = new Promise(resolve => { decided = resolve; });
  instance(scope, path, undefined, { recover: async decide => { decided(decide({ id: "old", preparation: "p" })); } },
    undefined, { now: () => now, receipts: { remove: async () => {}, sweep: async () => {} } });
  assert.deepEqual(await decision, { sent: false }, "an operation no longer retained is retired as unsent");
  assert.deepEqual((await stored(path)).operations, []);
});

test("a startup recovery held at the file system holds no state change, and its failures are reported", async (t) => {
  const scope = cleanupScope(t);
  const path = join(await scope.folder("compact-shutdown-"), "state.json");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reach!: () => void;
  const reached = new Promise<void>(resolve => { reach = resolve; });
  const reported: unknown[] = [];
  const failure = new Error("one conversation's request could not be read");
  const next = instance(scope, path, undefined, {
    recover: async (_decide, report) => {
      report(failure);
      reach();
      await held;
    },
  }, error => { reported.push(error); });
  await reached;
  await next.scheduler.ready;
  await next.scheduler.toggle("other", false);
  assert.deepEqual((await stored(path)).disabled, ["other"], "a state change does not wait for the held recovery");
  assert.deepEqual(reported, [failure]);
  release();
});

// The plugin itself, as Paseo runs it: the cleanup contribute() returns is the
// stop the host awaits before it starts the next instance.
async function plugin(scope: CleanupScope, files: DurableFiles) {
  const home = await paseoHome(scope, "compact-cleanup-");
  const { server, hook } = pluginHost();
  const cleanup = contribute(server, { files });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= cleanup();
  scope.defer(stop);
  type Before = (input: { request: PluginSessionOpenRequest }, context: unknown) => Promise<PluginSessionOpenRequest>;
  const request = { agentId: "a", workspaceId: "w", provider: "claude", purpose: "interactive", reason: "create",
    cwd: home, title: "Conversation", labels: {}, metadata: {}, background: false, tools: [], mcpServers: {},
    env: {} } as PluginSessionOpenRequest;
  const paseo = { config: { get: async () => ({ config: { providers: {} } }) } };
  const manifest = join(home, "plugin-data", "auto-compact-for-claude", "observers",
    createHash("sha256").update("a").digest("hex"), "current.json");
  return { open: () => hook<Before>("agent.open.before")({ request }, { paseo }), request, manifest, stop };
}

test("the plugin's stop resolves only once a write it had already issued has landed", async (t) => {
  const scope = cleanupScope(t);
  t.mock.method(console, "error", () => {});
  const { files, holdRename } = heldFiles();
  const f = await plugin(scope, files);
  const held = holdRename(f.manifest);
  const opening = f.open();
  await held.reached;
  let landed = false;
  void held.landed.then(() => { landed = true; });
  const stopped = f.stop().then(() => landed);
  held.release();
  assert.equal(await stopped, true, "the stop waited for the issued rename");
  await opening;
  assert.equal(typeof JSON.parse(await readFile(f.manifest, "utf8")).launchId, "string");
});

test("the plugin's stop closes its writes first, so a publication not yet issued never lands", async (t) => {
  const scope = cleanupScope(t);
  t.mock.method(console, "error", () => {});
  const { files, holdWrite } = heldFiles();
  const f = await plugin(scope, files);
  const held = holdWrite(f.manifest);
  const opening = f.open();
  await held.reached;
  const stopping = f.stop();
  held.release();
  await stopping;
  assert.deepEqual(await opening, f.request, "the session opens without an observer");
  await assert.rejects(readFile(f.manifest, "utf8"), { code: "ENOENT" });
});
