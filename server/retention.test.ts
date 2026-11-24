import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { HISTORY_RETENTION_MS, HISTORY_SWEEP_INTERVAL_MS, pruneOperationHistory, type OperationReceipts } from "./retention";
import { createScheduler } from "./scheduler";
import { createStore } from "./store";
import { DEFAULT_SETTINGS } from "../shared/settings";
import type { Gateway, Observation, State, StoredOperation } from "./model";
import { changes } from "../tests/support/changes";
import { cleanupScope, type CleanupScope } from "../tests/support/scope";

const now = HISTORY_RETENTION_MS + 1000;
const operation = (id: string, state: StoredOperation["state"] = "succeeded", updatedAt = 1000): StoredOperation => ({
  id, state, agentId: "a", revision: new Date(1000).toISOString(),
  target: { sessionId: "native-a", activityKey: "generation:1" },
  kind: "manual", createdAt: 500, updatedAt, inputFingerprint: "fingerprint",
  result: { code: "completed", message: "completed boundary" },
});
const stateWith = (...operations: StoredOperation[]): State => ({ version: 1, disabled: ["a"], jobs: [], operations });

test("retention uses terminal age inclusively, never pending age or last-N eviction", async () => {
  const state = stateWith(...["succeeded", "failed", "unknown", "expired"].map(s => operation(s, s as StoredOperation["state"])),
    ...["requested", "dispatching", "observing"].map(s => operation(s, s as StoredOperation["state"], 0)),
    operation("recent", "succeeded", 1001), operation("future", "succeeded", now + 1));
  const removed: string[] = [];
  const receipts: OperationReceipts = { remove: async (_agent, id) => { removed.push(id); }, sweep: async () => {} };
  await pruneOperationHistory(state, now, receipts, error => { throw error; });
  assert.deepEqual(removed, ["succeeded", "failed", "unknown", "expired"]);
  assert.deepEqual(state.operations.map(op => op.id), ["requested", "dispatching", "observing", "recent", "future"]);
  const bulk = stateWith(...Array.from({ length: 105 }, (_, i) => operation(`old-${i}`)), operation("young", "succeeded", now));
  assert.equal((await pruneOperationHistory(bulk, now, receipts, error => { throw error; })).backlog, true);
  assert.equal(bulk.operations.length, 6);
  await pruneOperationHistory(bulk, now, receipts, error => { throw error; });
  assert.deepEqual(bulk.operations.map(op => op.id), ["young"]);
});

test("receipt deletion failure preserves the operation while other expired records progress", async () => {
  const state = stateWith(operation("blocked"), operation("clean"));
  const errors: unknown[] = [];
  const receipts: OperationReceipts = { remove: async (_agent, id) => { if (id === "blocked") throw new Error("permission denied"); }, sweep: async () => {} };
  const result = await pruneOperationHistory(state, now, receipts, error => errors.push(error));
  assert.deepEqual(state.operations.map(op => op.id), ["blocked"]);
  assert.equal(result.backlog, true);
  assert.equal(errors.length, 1);
});

async function fixture(scope: CleanupScope) {
  const home = await scope.folder("compact-retention-");
  // A write already started when the test ends (this setup's, or one a
  // scheduler started before it stopped) still lands; it ends before the
  // folder goes, so it cannot recreate it.
  const writing = new Set<Promise<unknown>>();
  scope.defer(() => Promise.allSettled(writing));
  const file = createStore(join(home, "state.json"));
  const disk = { read: file.read, write: async (next: State) => {
    const write = file.write(next);
    writing.add(write);
    try { await write; } finally { writing.delete(write); }
  } };
  const old = operation("old");
  const state = stateWith(old);
  state.jobs.push({ agentId: "a", revision: old.revision, endedAt: 500, status: "completed", detail: "old outcome",
    attemptedAt: 500, operationId: old.id, sessionId: "native-a", activityKey: "generation:1" });
  await disk.write(state);
  let time = now, failCommit = false, failRemoval = false, sends = 0, sweeps = 0;
  const errors: unknown[] = [], removed: string[] = [];
  const agent: Observation = { agentId: "a", title: null, workspace: "/work", provider: "claude", revision: old.revision,
    tokens: 500_000, idle: true, eligible: true, sessionId: "native-a", activityKey: "generation:1" };
  const gateway: Gateway = { list: async (observe) => { observe(Promise.resolve(agent)); }, refresh: async () => agent,
    compact: async () => { sends++; return { status: "completed", detail: "completed" }; } };
  // Background work is awaited by the state it commits, not by elapsed time.
  const signal = changes();
  let stored = state;
  const store = { read: disk.read, write: async (next: State) => {
    if (failCommit && !next.operations.some(op => op.id === "old")) throw new Error("disk full");
    await disk.write(next);
    stored = structuredClone(next);
    signal.changed();
  } };
  const committed = (done: (state: State) => boolean) => signal.until(() => done(stored));
  const receipts: OperationReceipts = {
    remove: async (_agent, id) => {
      assert((await disk.read()).operations.some(op => op.id === id), "receipt must be removed before its record");
      if (failRemoval) throw new Error("receipt busy");
      removed.push(id);
    },
    sweep: async retained => {
      assert.deepEqual(retained, (await disk.read()).operations, "orphan protection uses committed state");
      sweeps++;
    },
  };
  return { agent, disk, removed, errors, committed,
    // Each scheduler runs on real timers, so it stops when the test ends,
    // before the folder its store writes to is removed.
    make() {
      const scheduler = createScheduler({ store, gateway, receipts, now: () => time,
        settings: async () => ({ ...DEFAULT_SETTINGS, enabled: false }), onError: error => errors.push(error) });
      scope.defer(() => scheduler.stop());
      return scheduler;
    },
    get sends() { return sends; }, get sweeps() { return sweeps; },
    failCommit(value: boolean) { failCommit = value; }, failRemoval(value: boolean) { failRemoval = value; },
    advance(ms: number) { time += ms; },
  };
}

test("cleanup survives a state commit failure and restart after receipt deletion", async (t) => {
  const f = await fixture(cleanupScope(t));
  f.failCommit(true);
  const first = f.make(); await first.ready;
  assert.deepEqual(f.removed, ["old"]);
  assert.equal((await first.operation("old"))?.state, "succeeded");
  assert.equal(f.sweeps, 0);
  first.stop(); f.failCommit(false);
  const second = f.make(); await second.ready;
  assert.equal(await second.operation("old"), null);
  assert.deepEqual(f.removed, ["old", "old"]);
  assert.equal(f.sweeps, 1);
  assert.equal(f.errors.length, 1);
  second.stop();
});

test("offline ticks retry removal failures; successful sweeps run hourly and tolerate clock rollback", async (t) => {
  const f = await fixture(cleanupScope(t));
  f.failRemoval(true);
  const s = f.make(); await s.ready;
  assert(await s.operation("old"));
  f.failRemoval(false); await s.tick(false);
  assert.equal(await s.operation("old"), null);
  const sweeps = f.sweeps;
  await s.tick(false); assert.equal(f.sweeps, sweeps);
  f.advance(HISTORY_SWEEP_INTERVAL_MS); await s.tick(false); assert.equal(f.sweeps, sweeps + 1);
  f.advance(-2 * HISTORY_SWEEP_INTERVAL_MS); await s.tick(false); assert.equal(f.sweeps, sweeps + 2);
  s.stop();
});

test("cleanup preserves same-activity protection across restart and allows a new native generation", async (t) => {
  const f = await fixture(cleanupScope(t));
  let s = f.make();
  await s.ready;
  assert.equal(await s.operation("old"), null);
  assert.deepEqual((await f.disk.read()).disabled, ["a"]);
  // Paseo can advance the host timestamp for /compact itself.
  f.agent.revision = new Date(2000).toISOString();
  const result = await s.compactNow("a", f.agent.revision, "new-id");
  assert.equal(result.code, "existing"); assert.equal(result.operationId, null);
  await s.observedTurn(f.agent); await s.tick(); assert.equal(f.sends, 0);
  s.stop(); s = f.make(); await s.ready;
  assert.equal((await s.compactNow("a", f.agent.revision, "another-id")).code, "existing");
  f.agent.activityKey = "new-generation:1";
  assert.equal((await s.compactNow("a", f.agent.revision, "fresh-id")).code, "accepted");
  await f.committed(state => state.operations.some(op => op.id === "fresh-id" && op.state === "succeeded"));
  assert.equal((await s.operation("fresh-id"))?.state, "succeeded");
  assert.equal(f.sends, 1);
});
