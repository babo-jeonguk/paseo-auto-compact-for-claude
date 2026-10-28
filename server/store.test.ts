import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "./store";
import { claudeProvider } from "./gateway";

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
          operationId: "manual-operation",
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
    assert.equal((await createStore(path).read()).jobs[0].operationId, "manual-operation");
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

test("v1 migration retains manual IDs and skip receipts, makes interrupted work unknown and persists v2", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-v2-"));
  try {
    const path = join(root, "state.json");
    const legacy = { version: 1, disabled: ["off"], jobs: [
      { agentId: "a", revision: "rev", endedAt: 10, attemptedAt: 20,
        operationId: "manual-id", status: "running", detail: "Running", sessionId: "native-a" },
      { agentId: "b", revision: "rev", endedAt: 10, status: "completed", detail: "Done" },
      { agentId: "c", revision: "rev", endedAt: 10, status: "skipped", detail: "Skipped",
        skip: { id: "skip", dueAt: 100, sessionId: "native-c" } },
    ] };
    await writeFile(path, JSON.stringify(legacy));
    const store = createStore(path), migrated = await store.read();
    assert.equal(migrated.version, 2);
    assert.deepEqual(await store.read(), migrated, "migration IDs must be deterministic");
    assert.equal(migrated.operations[0].id, "manual-id");
    assert.equal(migrated.operations[0].state, "unknown");
    assert.equal(migrated.operations[1].state, "succeeded");
    assert.deepEqual(migrated.jobs[2].skip, legacy.jobs[2].skip);
    await store.write(migrated);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
    assert.deepEqual(await createStore(path).read(), migrated);
    await assert.rejects(store.write({ ...migrated, operations: [migrated.operations[0], migrated.operations[0]] }));
    assert.deepEqual(await createStore(path).read(), migrated, "invalid write must not replace saved state");
    await writeFile(path, JSON.stringify({ ...migrated, version: 999 }));
    await assert.rejects(store.read(), /unreadable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
