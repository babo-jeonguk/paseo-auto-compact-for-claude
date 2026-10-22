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
    await first.write({
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
    });
    assert.deepEqual(await createStore(path).read(), await first.read());
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
    await store.write({ version: 1, disabled: ["a"], jobs: [
      { agentId: "a", revision: "old", endedAt: Date.now(), status: "scheduled", detail: "Old reservation" },
      { agentId: "b", revision: "done", endedAt: 100, status: "completed", detail: "Completed" },
      { agentId: "c", revision: "new", endedAt: Date.now(), status: "scheduled", detail: "Native reservation",
        activityKey: "launch:generation:1", sessionId: "native" },
    ] });
    const restored = await store.read();
    assert.deepEqual(restored.disabled, ["a"]);
    assert.equal(restored.jobs[0].status, "expired");
    assert.equal(restored.jobs[1].status, "completed");
    assert.equal(restored.jobs[2].status, "scheduled");
  } finally { await rm(root, { recursive: true, force: true }); }
});
