import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDurableWrites } from "./durable";
import { Stopped } from "./deadline";
import { cleanupScope } from "../tests/support/scope";
import { drainer } from "../tests/support/drained";
import { heldFiles } from "../tests/support/files";

async function folder(t: Parameters<typeof cleanupScope>[0]) {
  const root = await cleanupScope(t).folder("compact-durable-");
  return { root, path: join(root, "file.json") };
}

test("a replacement publishes the whole file and leaves no temporary file behind", async (t) => {
  const { root, path } = await folder(t);
  const writes = createDurableWrites();
  await writeFile(path, "before");
  await writes.replace(path, "after");
  assert.equal(await readFile(path, "utf8"), "after");
  assert.deepEqual(await readdir(root), ["file.json"]);
});

test("once closed, durable writes start nothing and touch no file", async (t) => {
  const { root, path } = await folder(t);
  const writes = createDurableWrites();
  await writeFile(path, "before");
  writes.close();
  let started = false;
  await assert.rejects(writes.run(async () => { started = true; }), Stopped);
  await assert.rejects(writes.replace(path, "after"), Stopped);
  assert.equal(started, false);
  assert.equal(await readFile(path, "utf8"), "before");
  assert.deepEqual(await readdir(root), ["file.json"]);
  await writes.drain();
});

test("a replacement whose rename was not issued when writes close is never published", async (t) => {
  const { root, path } = await folder(t);
  const { files, holdWrite } = heldFiles();
  const writes = createDurableWrites(files);
  const drained = drainer();
  await writeFile(path, "before");
  const held = holdWrite(path);
  const replacing = writes.replace(path, "after").then(() => null, (error: unknown) => error);
  await held.reached;
  writes.close();
  let ended = false;
  const draining = writes.drain().then(() => { ended = true; });
  await drained();
  assert.equal(ended, false, "the drain waits for the write already under way");
  held.release();
  await draining;
  assert.ok(await replacing instanceof Stopped, "the fenced replacement fails");
  assert.equal(await readFile(path, "utf8"), "before", "its rename was never issued");
  assert.deepEqual(await readdir(root), ["file.json"], "its temporary file is removed");
});

test("a rename already issued when writes close is drained until it lands, whoever stopped waiting on it", async (t) => {
  const { path } = await folder(t);
  const { files, holdRename } = heldFiles();
  const writes = createDurableWrites(files);
  const drained = drainer();
  await writeFile(path, "before");
  const held = holdRename(path);
  // The caller's own wait ends at once, as a stopped component's does; the
  // rename it issued is still accounted for.
  void writes.replace(path, "after").catch(() => {});
  await held.reached;
  writes.close();
  let ended = false;
  const draining = writes.drain().then(() => { ended = true; });
  await drained();
  assert.equal(ended, false, "the drain waits for the issued rename");
  held.release();
  await draining;
  await held.landed;
  assert.equal(await readFile(path, "utf8"), "after", "an issued rename completes before the drain ends");
});

test("a drain covers every write in flight, and work run through the writes is drained with them", async (t) => {
  const { path } = await folder(t);
  const { files, holdRename } = heldFiles();
  const writes = createDurableWrites(files);
  const drained = drainer();
  const held = holdRename(path);
  let release!: () => void;
  const work = new Promise<void>(resolve => { release = resolve; });
  const running = writes.run(() => work);
  const replacing = writes.replace(path, "after");
  await held.reached;
  writes.close();
  let ended = false;
  const draining = writes.drain().then(() => { ended = true; });
  held.release();
  await replacing;
  await drained();
  assert.equal(ended, false, "the run still holds the drain");
  release();
  await running;
  await draining;
});
