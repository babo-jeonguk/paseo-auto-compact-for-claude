import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded, DeadlineExceeded, Stopped } from "./deadline";
import { fakeTimers } from "../tests/support/timers";

test("a bounded wait runs on the caller's timers and clears its timer once the work settles", async () => {
  const timers = fakeTimers();
  let finish!: (value: string) => void;
  const waiting = bounded(new Promise<string>(resolve => { finish = resolve; }), 5_000, timers);
  assert.equal(timers.pending, 1, "the deadline is armed on the injected timers");
  await timers.tick(4_999);
  finish("done");
  assert.equal(await waiting, "done");
  assert.equal(timers.pending, 0, "nothing is left armed after the work ends");
  const failing = bounded(Promise.reject(new Error("EIO")), 5_000, timers);
  await assert.rejects(failing, /EIO/);
  assert.equal(timers.pending, 0);
});

test("a bounded wait fails at its deadline, and a late result is consumed", async () => {
  const timers = fakeTimers();
  let fail!: (error: Error) => void;
  const waiting = bounded(new Promise<never>((_resolve, reject) => { fail = reject; }), 5_000, timers);
  await timers.tick(5_000);
  await assert.rejects(waiting, DeadlineExceeded);
  assert.equal(timers.pending, 0);
  fail(new Error("late"));
});

test("a bounded wait ends when its attempt stops, and leaves no timer armed", async () => {
  const timers = fakeTimers();
  const attempt = new AbortController();
  const waiting = bounded(new Promise<never>(() => {}), 5_000, timers, attempt.signal);
  attempt.abort();
  await assert.rejects(waiting, Stopped);
  assert.equal(timers.pending, 0, "stopping the attempt clears its deadline");
  let armed = 0;
  const counted = { ...timers, setTimeout: (callback: () => void, ms: number) => { armed++; return timers.setTimeout(callback, ms); } };
  await assert.rejects(bounded(new Promise<never>(() => {}), 5_000, counted, attempt.signal), Stopped,
    "a wait started after its attempt stopped ends at once");
  assert.equal(armed, 0, "a wait started after its attempt stopped arms no deadline");
});

test("a wait with no deadline of its own arms no timer and ends only when its attempt stops", async () => {
  const timers = fakeTimers();
  const attempt = new AbortController();
  let finish!: (value: string) => void;
  const finishing = bounded(new Promise<string>(resolve => { finish = resolve; }), Infinity, timers, attempt.signal);
  assert.equal(timers.pending, 0, "no deadline is armed");
  finish("done");
  assert.equal(await finishing, "done");
  const stopped = bounded(new Promise<never>(() => {}), Infinity, timers, attempt.signal);
  assert.equal(timers.pending, 0);
  attempt.abort();
  await assert.rejects(stopped, Stopped);
});

test("a stopped wait clears its timer whatever handle the timers returned", async () => {
  // Timers is opaque about handles, so one may be undefined.
  const cleared: unknown[] = [];
  const timers = { setTimeout: () => undefined, clearTimeout: (handle: unknown) => { cleared.push(handle); } };
  const attempt = new AbortController();
  const waiting = bounded(new Promise<never>(() => {}), 5_000, timers, attempt.signal);
  attempt.abort();
  await assert.rejects(waiting, Stopped);
  assert.deepEqual(cleared, [undefined], "the armed deadline is cleared");
});

test("a bounded wait clears only its own timer, even on timers that reuse a retired handle", async () => {
  // Numbered handles, the lowest free one reused, as some timer implementations do.
  const due = new Map<number, () => void>();
  const timers = {
    setTimeout(callback: () => void) { let id = 1; while (due.has(id)) id++; due.set(id, callback); return id; },
    clearTimeout(handle: unknown) { due.delete(handle as number); },
  };
  const fire = (id: number) => { const callback = due.get(id)!; due.delete(id); callback(); };
  let fail!: (error: Error) => void;
  const work = new Promise<never>((_resolve, reject) => { fail = reject; });
  const first = bounded(work, 5_000, timers);
  fire(1);
  await assert.rejects(first, DeadlineExceeded);
  // The next wait takes the retired handle; then the first wait's work settles late.
  const second = bounded(new Promise<never>(() => {}), 5_000, timers);
  fail(new Error("late"));
  await work.catch(() => {});
  assert.equal(due.size, 1, "the second wait's deadline is still armed");
  fire(1);
  await assert.rejects(second, DeadlineExceeded);
});
