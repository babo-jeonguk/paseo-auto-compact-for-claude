import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDurableWrites, type DurableFiles } from "./durable";
import { createScheduler } from "./scheduler";
import { createCachedStore, createStore } from "./store";
import type { Gateway, Observation, State } from "./model";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { cleanupScope, type CleanupScope } from "../tests/support/scope";
import { drainer } from "../tests/support/drained";
import { fakeTimers } from "../tests/support/timers";
import { heldFiles } from "../tests/support/files";

// A plugin reload under one daemon: the host stops the old instance, which
// closes its durable writes and drains them, and starts the next one only once
// that has ended. These tests play that handoff with two instances on one
// state file and check what the next instance finds and keeps.
const agent: Observation = { agentId: "a", title: null, workspace: "/work", provider: "claude",
  revision: new Date(1_000_000).toISOString(), tokens: 210_000, eligible: true, idle: true, sessionId: "native-a" };
const native = { id: "op", launchId: "launch", generation: "generation", sessionId: "native-a", revision: 1 };

function instance(scope: CleanupScope, path: string, files?: DurableFiles, gateway: Partial<Gateway> = {}) {
  const writes = createDurableWrites(files);
  const scheduler = createScheduler({
    store: createCachedStore(createStore(path, writes)),
    gateway: { list: async () => {}, refresh: async () => structuredClone(agent),
      compact: async () => ({ status: "completed", detail: "done" }), ...gateway },
    settings: async () => ({ ...DEFAULT_SETTINGS }),
    now: () => 1_000_000,
    timers: fakeTimers(),
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
  const next = instance(scope, path, undefined, {
    recover: async decide => {
      for (const id of ["observed", "unsent", "finished", "missing"]) decisions.set(id, decide({ id, preparation: "p" }));
    },
  });
  await next.scheduler.ready;
  assert.deepEqual(Object.fromEntries(decisions), {
    observed: null, unsent: { sent: false }, finished: { sent: true }, missing: { sent: false },
  });
});
