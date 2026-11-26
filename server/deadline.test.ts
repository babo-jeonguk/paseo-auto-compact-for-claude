import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded, createLifetime, DeadlineExceeded, pause, Stopped } from "./deadline";
import { fakeTimers, reusedHandleTimers, undefinedHandleTimers } from "../tests/support/timers";

// The owner of a wait's work, for a rejection that arrives after the wait has
// ended; `handed` resolves with the first one it is given.
function owner() {
  const received: unknown[] = [];
  let hand!: (error: unknown) => void;
  const handed = new Promise<unknown>(resolve => { hand = resolve; });
  return { received, handed, late: (error: unknown) => { received.push(error); hand(error); } };
}

test("a bounded wait runs on the caller's timers and clears its timer once the work settles", async () => {
  const timers = fakeTimers();
  const work = owner();
  let finish!: (value: string) => void;
  const waiting = bounded(new Promise<string>(resolve => { finish = resolve; }), 5_000, timers, work.late);
  assert.equal(timers.pending, 1, "the deadline is armed on the injected timers");
  await timers.tick(4_999);
  finish("done");
  assert.equal(await waiting, "done");
  assert.equal(timers.pending, 0, "nothing is left armed after the work ends");
  const failure = new Error("EIO");
  const failing = bounded(Promise.reject(failure), 5_000, timers, work.late);
  assert.equal(await failing.then(() => null, (error: unknown) => error), failure,
    "a rejection before the wait ended goes to the caller");
  assert.equal(timers.pending, 0);
  assert.deepEqual(work.received, [], "and is not handed to the owner as well");
});

test("a bounded wait fails at its deadline, and a later rejection of its work goes to the work's owner", async () => {
  const timers = fakeTimers();
  const work = owner();
  let fail!: (error: Error) => void;
  const waiting = bounded(new Promise<never>((_resolve, reject) => { fail = reject; }), 5_000, timers, work.late);
  await timers.tick(5_000);
  await assert.rejects(waiting, DeadlineExceeded);
  assert.equal(timers.pending, 0);
  const late = new Error("late");
  fail(late);
  assert.equal(await work.handed, late, "the owner receives the original error");
  assert.deepEqual(work.received, [late]);
});

test("a rejection after the wait was stopped goes to the work's owner", async () => {
  const timers = fakeTimers();
  const work = owner();
  const attempt = new AbortController();
  let fail!: (error: Error) => void;
  const waiting = bounded(new Promise<never>((_resolve, reject) => { fail = reject; }), Infinity, timers, work.late,
    attempt.signal);
  attempt.abort();
  await assert.rejects(waiting, Stopped);
  const late = new Error("late after stop");
  fail(late);
  assert.equal(await work.handed, late);
  assert.deepEqual(work.received, [late]);
});

test("a bounded wait ends when its attempt stops, and leaves no timer armed", async () => {
  const timers = fakeTimers();
  const attempt = new AbortController();
  const waiting = bounded(new Promise<never>(() => {}), 5_000, timers, owner().late, attempt.signal);
  attempt.abort();
  await assert.rejects(waiting, Stopped);
  assert.equal(timers.pending, 0, "stopping the attempt clears its deadline");
  let armed = 0;
  const counted = { ...timers, setTimeout: (callback: () => void, ms: number) => { armed++; return timers.setTimeout(callback, ms); } };
  await assert.rejects(bounded(new Promise<never>(() => {}), 5_000, counted, owner().late, attempt.signal), Stopped,
    "a wait started after its attempt stopped ends at once");
  assert.equal(armed, 0, "a wait started after its attempt stopped arms no deadline");
});

test("a wait with no deadline of its own arms no timer and ends only when its attempt stops", async () => {
  const timers = fakeTimers();
  const attempt = new AbortController();
  let finish!: (value: string) => void;
  const finishing = bounded(new Promise<string>(resolve => { finish = resolve; }), Infinity, timers, owner().late,
    attempt.signal);
  assert.equal(timers.pending, 0, "no deadline is armed");
  finish("done");
  assert.equal(await finishing, "done");
  const stopped = bounded(new Promise<never>(() => {}), Infinity, timers, owner().late, attempt.signal);
  assert.equal(timers.pending, 0);
  attempt.abort();
  await assert.rejects(stopped, Stopped);
});

test("a stopped wait clears its timer whatever handle the timers returned", async () => {
  // Timers is opaque about handles, so one may be undefined.
  const timers = undefinedHandleTimers();
  const attempt = new AbortController();
  const waiting = bounded(new Promise<never>(() => {}), 5_000, timers, owner().late, attempt.signal);
  attempt.abort();
  await assert.rejects(waiting, Stopped);
  assert.deepEqual(timers.cleared, [undefined], "the armed deadline is cleared");
});

test("a bounded wait clears only its own timer, even on timers that reuse a retired handle", async () => {
  // Numbered handles, the lowest free one reused, as some timer implementations do.
  const timers = reusedHandleTimers();
  const late = owner();
  let fail!: (error: Error) => void;
  const work = new Promise<never>((_resolve, reject) => { fail = reject; });
  const first = bounded(work, 5_000, timers, late.late);
  timers.fire(1);
  await assert.rejects(first, DeadlineExceeded);
  // The next wait takes the retired handle; then the first wait's work settles late.
  const second = bounded(new Promise<never>(() => {}), 5_000, timers, owner().late);
  fail(new Error("late"));
  await late.handed;
  assert.equal(timers.pending, 1, "the second wait's deadline is still armed");
  timers.fire(1);
  await assert.rejects(second, DeadlineExceeded);
});

test("ending a lifetime ends every wait on it at once, and a wait after it arms nothing", async () => {
  const timers = fakeTimers();
  const lifetime = createLifetime(timers, owner().late);
  const unbounded = lifetime.wait(new Promise<never>(() => {}));
  const bounded = lifetime.wait(new Promise<never>(() => {}), 5_000);
  assert.equal(timers.pending, 1, "only the wait with a deadline arms a timer");
  assert.equal(lifetime.live(), true);
  lifetime.end();
  assert.equal(lifetime.live(), false);
  assert.equal(timers.pending, 0);
  await assert.rejects(unbounded, Stopped);
  await assert.rejects(bounded, Stopped);
  await assert.rejects(lifetime.wait(Promise.resolve("late"), 5_000), Stopped);
  assert.equal(timers.pending, 0);
});

test("a lifetime begins work only while it lasts", async () => {
  const timers = fakeTimers();
  const lifetime = createLifetime(timers, owner().late);
  const begun: string[] = [];
  assert.equal(await lifetime.begin(async () => { begun.push("live"); return "read"; }), "read");
  lifetime.end();
  await assert.rejects(lifetime.begin(async () => { begun.push("ended"); return "read"; }), Stopped);
  assert.deepEqual(begun, ["live"]);
  assert.equal(timers.pending, 0);
});

test("a lifetime hands a rejection after it ended to its owner, or to the owner a wait names", async () => {
  const timers = fakeTimers();
  const component = owner(), attempt = owner();
  const lifetime = createLifetime(timers, component.late);
  let failComponent!: (error: Error) => void, failAttempt!: (error: Error) => void;
  const waits = [
    lifetime.wait(new Promise<never>((_resolve, reject) => { failComponent = reject; })),
    lifetime.wait(new Promise<never>((_resolve, reject) => { failAttempt = reject; }), 5_000, attempt.late),
  ];
  lifetime.end();
  for (const waiting of waits) await assert.rejects(waiting, Stopped);
  const first = new Error("component work failed late"), second = new Error("attempt work failed late");
  failComponent(first);
  failAttempt(second);
  assert.equal(await component.handed, first);
  assert.equal(await attempt.handed, second);
  assert.deepEqual(component.received, [first]);
  assert.deepEqual(attempt.received, [second]);
});

test("a pause ends at its time, or at once with Stopped when its caller stops, and arms nothing once stopped", async () => {
  const timers = fakeTimers();
  let ended = false;
  const pausing = pause(1_000, timers).then(() => { ended = true; });
  assert.equal(timers.pending, 1);
  await timers.tick(999);
  assert.equal(ended, false);
  await timers.tick(1);
  await pausing;
  assert.equal(timers.pending, 0);
  const attempt = new AbortController();
  const stopped = pause(1_000, timers, attempt.signal);
  attempt.abort();
  await assert.rejects(stopped, Stopped);
  assert.equal(timers.pending, 0, "stopping clears its timer");
  await assert.rejects(pause(1_000, timers, attempt.signal), Stopped);
  assert.equal(timers.pending, 0, "a pause after the stop arms nothing");
});
