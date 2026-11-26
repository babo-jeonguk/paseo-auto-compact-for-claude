import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeyedQueue, createQueue } from "./queue";
import { gate } from "../tests/support/gate";
import { drainer } from "../tests/support/drained";

test("a queue runs its entries in call order, one at a time, and gives each caller its own outcome", async () => {
  const queue = createQueue();
  const drained = drainer();
  const order: string[] = [];
  const first = gate();
  const failure = new Error("second failed");
  const one = queue.run(async () => { order.push("one"); await first.pass(); return 1; });
  const two = queue.run(async () => { order.push("two"); throw failure; })
    .then(() => null, (error: unknown) => error);
  const three = queue.run(async () => { order.push("three"); return 3; });
  await first.reached;
  await drained();
  assert.deepEqual(order, ["one"], "later entries wait for the one running");
  first.release();
  assert.equal(await one, 1);
  assert.equal(await two, failure, "the caller receives its own work's rejection");
  assert.equal(await three, 3, "an entry after a rejected one still runs");
  assert.deepEqual(order, ["one", "two", "three"]);
});

test("an entry after work that throws synchronously still runs", async () => {
  const queue = createQueue();
  const failure = new Error("thrown before any await");
  const thrown = queue.run(() => { throw failure; }).then(() => null, (error: unknown) => error);
  assert.equal(await thrown, failure);
  assert.equal(await queue.run(async () => "next"), "next");
});

test("a keyed queue keeps the chains of different keys independent and reuses a key once it is idle", async () => {
  const queue = createKeyedQueue<string>();
  const drained = drainer();
  const held = gate();
  const order: string[] = [];
  const a = queue.run("a", async () => { order.push("a1"); await held.pass(); });
  const b = queue.run("b", async () => { order.push("b1"); return "b"; });
  const later = queue.run("a", async () => { order.push("a2"); });
  await held.reached;
  assert.equal(await b, "b", "another key runs while this one is held");
  await drained();
  assert.deepEqual(order, ["a1", "b1"], "the same key waits");
  held.release();
  await a;
  await later;
  assert.deepEqual(order, ["a1", "b1", "a2"]);
  // Once idle, the key starts a fresh chain at once.
  const failure = new Error("after idle");
  const rejected = queue.run("a", async () => { throw failure; }).then(() => null, (error: unknown) => error);
  assert.equal(await rejected, failure);
  assert.equal(await queue.run("a", async () => "reused"), "reused");
});

test("holding a key blocks it until released, and a release before the hold is ready frees it once it reaches the front", async () => {
  const queue = createKeyedQueue<string>();
  const drained = drainer();
  const first = queue.hold("a");
  await first.ready;
  // This acquisition is given up before it is ready, as a wait that timed out does.
  const abandoned = queue.hold("a");
  abandoned.release();
  let ran = false;
  const next = queue.run("a", async () => { ran = true; });
  await drained();
  assert.equal(ran, false, "the key is still held by the first hold");
  first.release();
  await abandoned.ready;
  await next;
  assert.equal(ran, true, "the abandoned hold released its slot when it reached the front");
  first.release();
  assert.equal(await queue.run("a", async () => "again"), "again", "a second release changes nothing");
});

test("a hold released after other work keeps the key until that work has ended", async () => {
  const queue = createKeyedQueue<string>();
  const drained = drainer();
  const hold = queue.hold("a");
  await hold.ready;
  let finish!: () => void;
  hold.release(new Promise<void>(resolve => { finish = resolve; }));
  let ran = false;
  const next = queue.run("a", async () => { ran = true; });
  await drained();
  assert.equal(ran, false, "the key stays held until the work it was released after ends");
  finish();
  await next;
  assert.equal(ran, true);
});

test("a key's idle resolves once the entries queued so far have ended, and never rejects", async () => {
  const queue = createKeyedQueue<string>();
  const drained = drainer();
  assert.equal(await queue.idle("a"), undefined, "an unused key is idle");
  const held = gate();
  const failure = new Error("queued work failed");
  const failing = queue.run("a", async () => { await held.pass(); throw failure; })
    .then(() => null, (error: unknown) => error);
  let idle = false;
  const waiting = queue.idle("a").then(() => { idle = true; });
  await held.reached;
  await drained();
  assert.equal(idle, false, "idle waits for the entry already queued");
  held.release();
  await waiting;
  assert.equal(await failing, failure, "the rejection stays with the entry's caller");
});
