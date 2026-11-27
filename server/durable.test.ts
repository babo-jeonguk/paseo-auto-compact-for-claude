import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDurableWrites, type DurableFiles } from "./durable";
import { createReporter } from "./report";
import { Stopped } from "./deadline";
import { cleanupScope } from "../tests/support/scope";
import { drainer } from "../tests/support/drained";
import { heldFiles } from "../tests/support/files";
import { gate } from "../tests/support/gate";
import { defects } from "../tests/support/defects";

// The owner the writes are given as they close; `handed` is what it received.
function teardown() {
  const handed: unknown[] = [];
  return { handed, owner: (error: unknown) => { handed.push(error); } };
}

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
  const shutdown = teardown();
  writes.close(shutdown.owner);
  let started = false;
  await assert.rejects(writes.run(async () => { started = true; }), Stopped);
  await assert.rejects(writes.replace(path, "after"), Stopped);
  assert.equal(started, false);
  assert.equal(await readFile(path, "utf8"), "before");
  assert.deepEqual(await readdir(root), ["file.json"]);
  await writes.drain();
  assert.deepEqual(shutdown.handed, [], "work refused at close was never in flight");
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
  const shutdown = teardown();
  writes.close(shutdown.owner);
  let ended = false;
  const draining = writes.drain().then(() => { ended = true; });
  await drained();
  assert.equal(ended, false, "the drain waits for the write already under way");
  held.release();
  await draining;
  assert.ok(await replacing instanceof Stopped, "the fenced replacement fails");
  assert.equal(await readFile(path, "utf8"), "before", "its rename was never issued");
  assert.deepEqual(await readdir(root), ["file.json"], "its temporary file is removed");
  assert.deepEqual(defects(shutdown.handed), [], "only the fence's own stop reaches the owner");
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
  const shutdown = teardown();
  writes.close(shutdown.owner);
  let ended = false;
  const draining = writes.drain().then(() => { ended = true; });
  await drained();
  assert.equal(ended, false, "the drain waits for the issued rename");
  held.release();
  await draining;
  await held.landed;
  assert.equal(await readFile(path, "utf8"), "after", "an issued rename completes before the drain ends");
  assert.deepEqual(shutdown.handed, []);
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
  const shutdown = teardown();
  writes.close(shutdown.owner);
  let ended = false;
  const draining = writes.drain().then(() => { ended = true; });
  held.release();
  await replacing;
  await drained();
  assert.equal(ended, false, "the run still holds the drain");
  release();
  await running;
  await draining;
  assert.deepEqual(shutdown.handed, []);
});

// A rename onto the target that is held once called, then fails with
// `failure` when released, as a disk that fails a rename the OS had issued.
function failingRename(failure: Error) {
  const held = gate();
  const files: DurableFiles = { writeFile: fs.writeFile, rm: fs.rm,
    rename: async () => { await held.pass(); throw failure; } };
  return { files, held };
}

test("a write that fails once writes have closed is logged once at teardown, through nested writes, and its caller still gets it", async (t) => {
  const { path } = await folder(t);
  const failure = new Error("EIO: rename");
  const { files, held } = failingRename(failure);
  const writes = createDurableWrites(files);
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line));
  // A writer that replaces a file inside work it runs through the writes, as
  // the observer's preparation does.
  const nested = writes.run(() => writes.replace(path, "after")).then(() => null, (error: unknown) => error);
  await held.reached;
  reporter.dispose();
  writes.close(reporter.teardown);
  held.release();
  assert.equal(await nested, failure, "the caller receives the original failure");
  await writes.drain();
  assert.deepEqual(lines, ["Error: EIO: rename"], "the failure is logged once, however many writes saw it");
});

test("a write that fails before writes close is its caller's alone", async (t) => {
  const { path } = await folder(t);
  const failure = new Error("EIO: rename");
  const { files, held } = failingRename(failure);
  const writes = createDurableWrites(files);
  const replacing = writes.replace(path, "after").then(() => null, (error: unknown) => error);
  await held.reached;
  held.release();
  assert.equal(await replacing, failure);
  const shutdown = teardown();
  writes.close(shutdown.owner);
  await writes.drain();
  assert.deepEqual(shutdown.handed, []);
});

test("a replacement whose publication and temporary-file removal both fail keeps both failures", async (t) => {
  const { path } = await folder(t);
  const publication = new Error("EIO: rename"), cleanup = new Error("EACCES: rm");
  const files: DurableFiles = { writeFile: fs.writeFile,
    rename: async () => { throw publication; }, rm: async () => { throw cleanup; } };
  const outcome = await createDurableWrites(files).replace(path, "after").then(() => null, (error: unknown) => error);
  assert.ok(outcome instanceof AggregateError, "one rejection carries both");
  assert.deepEqual(outcome.errors, [publication, cleanup]);
});

test("a replacement that published but could not remove its temporary file rejects with that failure, and the file is published", async (t) => {
  const { path } = await folder(t);
  const cleanup = new Error("EACCES: rm");
  const files: DurableFiles = { writeFile: fs.writeFile, rename: fs.rename, rm: async () => { throw cleanup; } };
  await writeFile(path, "before");
  const outcome = await createDurableWrites(files).replace(path, "after").then(() => null, (error: unknown) => error);
  assert.equal(outcome, cleanup);
  assert.equal(await readFile(path, "utf8"), "after");
});
