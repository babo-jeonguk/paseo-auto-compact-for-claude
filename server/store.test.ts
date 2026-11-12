import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createCachedStore, createStore } from "./store";
import type { State, StateStore } from "./model";
import { claudeProvider } from "./gateway";
import { syncJobs } from "./operations";
import { StatusSchema } from "../shared/rpc";

const released = new URL("../tests/fixtures/state-v1.0.2.json", import.meta.url);
// v1.0.2's own state schema, verbatim: what a rollback reads.
const V102StateSchema = z.object({
  version: z.literal(1),
  disabled: z.array(z.string()),
  jobs: z.array(
    z.object({
      agentId: z.string(),
      revision: z.string(),
      endedAt: z.number().finite(),
      status: StatusSchema,
      detail: z.string(),
      attemptedAt: z.number().finite().optional(),
      activityKey: z.string().optional(),
      sessionId: z.string().optional(),
      skip: z.object({
        id: z.string().min(1),
        dueAt: z.number().finite(),
        sessionId: z.string().min(1),
      }).optional(),
    })
  ),
});

test("file store retains off policies and processed revisions across instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-store-"));
  try {
    const path = join(root, "state.json");
    const first = createStore(path);
    assert.equal((await first.read()).jobs.length, 0);
    await writeFile(path, JSON.stringify({
      version: 1,
      disabled: ["a"],
      jobs: [
        {
          agentId: "a",
          revision: "revision",
          endedAt: 100,
          attemptedAt: 200,
          status: "completed",
          detail: "Completed",
        },
        {
          agentId: "b",
          revision: "skipped-revision",
          endedAt: 300,
          status: "skipped",
          detail: "This reservation skipped; session policy unchanged",
          skip: { id: "skip-id", dueAt: 1000, sessionId: "native-b" },
        },
      ],
    }));
    assert.deepEqual(await createStore(path).read(), await first.read());
    assert.match((await createStore(path).read()).jobs[0].operationId!, /^legacy-[0-9a-f]{64}$/);
    assert.deepEqual((await createStore(path).read()).jobs[1].skip,
      { id: "skip-id", dueAt: 1000, sessionId: "native-b" });
    await writeFile(path, "{broken");
    await assert.rejects(first.read(), /unreadable/);
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider inheritance follows exact Claude root, rejects substring names and cycles", () => {
  const providers = {
    work: { extends: "team" },
    team: { extends: "claude" },
    a: { extends: "b" },
    b: { extends: "a" },
  };
  assert.equal(claudeProvider(providers, "work"), true);
  assert.equal(claudeProvider(providers, "claude"), true);
  assert.equal(claudeProvider(providers, "not-claude"), false);
  assert.equal(claudeProvider(providers, "a"), false);
});

test("migration expires old pending work while preserving settings-independent off choices and history", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-store-migrate-"));
  try {
    const path = join(root, "state.json");
    const store = createStore(path);
    await writeFile(path, JSON.stringify({ version: 1, disabled: ["a"], jobs: [
      { agentId: "a", revision: "old", endedAt: Date.now(), status: "scheduled", detail: "Old reservation" },
      { agentId: "b", revision: "done", endedAt: 100, status: "completed", detail: "Completed" },
      { agentId: "c", revision: "new", endedAt: Date.now(), status: "scheduled", detail: "Native reservation",
        activityKey: "launch:generation:1", sessionId: "native" },
    ] }));
    const restored = await store.read();
    assert.deepEqual(restored.disabled, ["a"]);
    assert.equal(restored.jobs[0].status, "expired");
    assert.equal(restored.jobs[1].status, "completed");
    assert.equal(restored.jobs[2].status, "scheduled");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the state v1.0.2 really wrote migrates to legacy history and keeps every guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-v1.0.2-"));
  try {
    const path = join(root, "state.json");
    const legacy = JSON.parse(await readFile(released, "utf8"));
    await writeFile(path, JSON.stringify(legacy));
    const store = createStore(path), migrated = await store.read();
    assert.deepEqual(await store.read(), migrated, "migration IDs must be deterministic");
    const byAgent = (id: string) => migrated.operations.find(op => op.agentId === id);
    assert.deepEqual(migrated.operations.map(op => op.agentId).sort(), ["automatic", "failed", "interrupted", "manual"]);
    // v1.0.2 did not record who asked; nothing pretends to know.
    assert(migrated.operations.every(op => op.kind === "legacy" && op.result?.code === "legacy_outcome"));
    assert.equal(byAgent("interrupted")?.state, "unknown");
    assert.equal(byAgent("failed")?.state, "failed");
    assert.equal(byAgent("manual")?.state, "succeeded");
    assert.deepEqual(migrated.disabled, ["off"]);
    const job = (id: string) => migrated.jobs.find(entry => entry.agentId === id)!;
    assert.equal(job("reserved").status, "scheduled");
    assert.deepEqual(job("skipped").skip, legacy.jobs.find((entry: { agentId: string }) => entry.agentId === "skipped").skip);
    await store.write(syncJobs(migrated));
    const written = JSON.parse(await readFile(path, "utf8"));
    assert.equal(written.version, 1, "additive fields keep the version v1.0.2 reads");
    assert.deepEqual(await createStore(path).read(), migrated);
    await assert.rejects(store.write({ ...migrated, operations: [migrated.operations[0], migrated.operations[0]] }));
    assert.deepEqual(await createStore(path).read(), migrated, "invalid write must not replace saved state");
    await writeFile(path, JSON.stringify({ ...written, version: 2 }));
    await assert.rejects(store.read(), /unreadable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a rollback to v1.0.2 reads our state, keeps attempted activities guarded and rolls forward again", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-rollback-"));
  try {
    const path = join(root, "state.json");
    const target = { sessionId: "native-a", activityKey: "launch:generation:1" };
    const operation = (id: string, state: "succeeded" | "expired" | "requested") => ({ id, agentId: id, revision: "rev", target,
      kind: "manual" as const, state, createdAt: 50, updatedAt: 60, inputFingerprint: "f",
      result: state === "requested" ? null : { code: state, message: state } });
    const state = syncJobs({ version: 1, disabled: ["off"], operations: ["succeeded", "expired", "requested"]
      .map(entry => operation(entry, entry as "succeeded")), jobs: ["succeeded", "expired", "requested"].map(id => ({
      agentId: id, revision: "rev", endedAt: 10, status: "scheduled" as const, detail: "", operationId: id,
      sessionId: "native-a", activityKey: "launch:generation:1" })) });
    await createStore(path).write(state);
    // What v1.0.2 sees: its schema accepts the file and drops what it does not know.
    const seen = V102StateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const job = (id: string) => seen.jobs.find(entry => entry.agentId === id)!;
    assert.deepEqual([job("succeeded").status, job("succeeded").attemptedAt], ["completed", 50], "v1.0.2 will not repeat it");
    assert.deepEqual([job("expired").status, job("expired").attemptedAt], ["expired", undefined], "v1.0.2 may retry it manually");
    assert.equal(job("requested").status, "running", "v1.0.2 recovers it as unknown, never resends");
    assert.equal("operations" in seen, false);
    // v1.0.2 writes the file back without operations; this release migrates it again.
    await writeFile(path, JSON.stringify(seen));
    const forward = await createStore(path).read();
    assert.deepEqual(forward.disabled, ["off"]);
    assert.deepEqual(forward.operations.map(op => [op.agentId, op.kind, op.state]),
      [["succeeded", "legacy", "succeeded"], ["requested", "legacy", "unknown"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A store that counts what reaches the file, standing in for the file store.
function countingStore(initial: State = { version: 1, disabled: ["a"], jobs: [], operations: [] }) {
  let saved = structuredClone(initial);
  const counts = { reads: 0, writes: 0 };
  let failRead: Error | null = null, failWrite: Error | null = null;
  let gate: Promise<void> | null = null;
  const inner: StateStore = {
    async read() {
      counts.reads++;
      const snapshot = structuredClone(saved);
      if (gate) await gate;
      if (failRead) throw failRead;
      return snapshot;
    },
    async write(state) {
      counts.writes++;
      if (failWrite) throw failWrite;
      saved = structuredClone(state);
    },
  };
  return {
    inner, counts,
    get saved() { return saved; },
    failRead(error: Error | null) { failRead = error; },
    failWrite(error: Error | null) { failWrite = error; },
    hold() { let release!: () => void; gate = new Promise(resolve => { release = resolve; }); return () => { gate = null; release(); }; },
  };
}

test("repeated state reads are served from memory after the first read", async () => {
  const file = countingStore();
  const store = createCachedStore(file.inner);
  for (let i = 0; i < 5; i++) assert.deepEqual((await store.read()).disabled, ["a"]);
  assert.equal(file.counts.reads, 1);
});

test("a successful write is what later reads return, without reading the file again", async () => {
  const file = countingStore();
  const store = createCachedStore(file.inner);
  const state = await store.read();
  state.disabled.push("b");
  await store.write(state);
  assert.deepEqual((await store.read()).disabled, ["a", "b"]);
  assert.deepEqual(file.saved.disabled, ["a", "b"]);
  assert.equal(file.counts.reads, 1);
  assert.equal(file.counts.writes, 1);
});

test("a write before any read is cached too", async () => {
  const file = countingStore();
  const store = createCachedStore(file.inner);
  await store.write({ version: 1, disabled: ["z"], jobs: [], operations: [] });
  assert.deepEqual((await store.read()).disabled, ["z"]);
  assert.equal(file.counts.reads, 0);
});

test("a failed write leaves the last persisted snapshot readable", async () => {
  const file = countingStore();
  const store = createCachedStore(file.inner);
  const state = await store.read();
  state.disabled = ["never-persisted"];
  file.failWrite(new Error("disk full"));
  await assert.rejects(store.write(state), /disk full/);
  assert.deepEqual((await store.read()).disabled, ["a"]);
  assert.deepEqual(file.saved.disabled, ["a"]);
});

test("callers cannot change the cached snapshot through a read or a written object", async () => {
  const file = countingStore();
  const store = createCachedStore(file.inner);
  const first = await store.read();
  first.disabled.push("mutated-after-read");
  assert.deepEqual((await store.read()).disabled, ["a"]);
  const next = await store.read();
  next.disabled = ["written"];
  await store.write(next);
  next.disabled.push("mutated-after-write");
  assert.deepEqual((await store.read()).disabled, ["written"]);
  const a = await store.read(), b = await store.read();
  assert.notEqual(a, b);
  assert.notEqual(a.disabled, b.disabled);
});

test("a read error is not cached: the next read asks the file again", async () => {
  const file = countingStore();
  const cold = createCachedStore(file.inner);
  file.failRead(new Error("Auto Compact state is unreadable; automation stopped"));
  await assert.rejects(cold.read(), /unreadable/);
  await assert.rejects(cold.read(), /unreadable/);
  file.failRead(null);
  assert.deepEqual((await cold.read()).disabled, ["a"]);
  assert.equal(file.counts.reads, 3);
});

test("a write that lands while the first read is in flight is not replaced by that older read", async () => {
  const file = countingStore();
  const store = createCachedStore(file.inner);
  const release = file.hold();
  const stale = store.read();
  await store.write({ version: 1, disabled: ["newer"], jobs: [], operations: [] });
  release();
  assert.deepEqual((await stale).disabled, ["a"], "the in-flight read still answers with what it read");
  assert.deepEqual((await store.read()).disabled, ["newer"]);
});

test("the cached file store keeps today's unreadable-state failure and missing-file default", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-cached-store-"));
  try {
    const path = join(root, "state.json");
    const missing = createCachedStore(createStore(path));
    assert.deepEqual(await missing.read(), { version: 1, disabled: [], jobs: [], operations: [] });
    await writeFile(join(root, "corrupt.json"), "{not json");
    const corrupt = createCachedStore(createStore(join(root, "corrupt.json")));
    await assert.rejects(corrupt.read(), /unreadable; automation stopped/);
    await assert.rejects(corrupt.read(), /unreadable; automation stopped/);
    await writeFile(join(root, "corrupt.json"), JSON.stringify({ version: 1, disabled: ["x"], jobs: [], operations: [] }));
    assert.deepEqual((await corrupt.read()).disabled, ["x"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
