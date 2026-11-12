import assert from "node:assert/strict";
import { test } from "node:test";
import { createSharedClock } from "../client/clock.ts";

// Deterministic timers: nothing runs until the test advances time.
function fakeTimers(start = 1_000_000) {
  let time = start, nextId = 1;
  const pending = new Map();
  return {
    now: () => time,
    setTimeout(callback, ms) { const id = nextId++; pending.set(id, { at: time + Math.max(0, ms), callback }); return id; },
    clearTimeout(id) { pending.delete(id); },
    get active() { return [...pending.values()].map(entry => entry.at).sort((a, b) => a - b); },
    advance(ms) {
      const until = time + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        time = due[1].at;
        due[1].callback();
      }
      time = until;
    },
  };
}

test("controls showing countdowns share one timer set for the earliest boundary", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  clock.subscribe(() => {}, now => now + 30_000);
  clock.subscribe(() => {}, now => now + 1_000);
  assert.deepEqual(timers.active, [start + 1_000]);
});

test("every subscriber is notified at the boundary with the current time", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const first = [], second = [];
  clock.subscribe(now => first.push(now), now => now + 30_000);
  clock.subscribe(now => second.push(now), now => now + 1_000);
  timers.advance(999);
  assert.deepEqual([first, second], [[], []]);
  timers.advance(1);
  assert.deepEqual(first, [start + 1_000]);
  assert.deepEqual(second, [start + 1_000]);
});

test("after a boundary the clock reschedules to the next one", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const dueAt = start + 4 * 60_000 + 30_000;
  // A minute countdown: next boundary is where the displayed minute changes.
  const boundary = now => dueAt - now > 60_000 ? now + ((dueAt - now - 1) % 60_000) + 1 : null;
  const seen = [];
  clock.subscribe(now => seen.push(now), boundary);
  assert.deepEqual(timers.active, [start + 30_000]);
  timers.advance(30_000);
  assert.deepEqual(timers.active, [start + 90_000]);
  timers.advance(3 * 60_000 + 30_000);
  assert.deepEqual(seen, [start + 30_000, start + 90_000, start + 150_000, start + 210_000]);
  assert.deepEqual(timers.active, [], "no countdown left: no timer");
});

test("no subscriber with a boundary means no timer", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  clock.subscribe(() => {}, () => null);
  clock.subscribe(() => {}, () => null);
  assert.deepEqual(timers.active, []);
});

test("the timer is cleared when the last subscriber leaves, and only then", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const leaveFirst = clock.subscribe(() => {}, now => now + 1_000);
  const leaveSecond = clock.subscribe(() => {}, now => now + 5_000);
  leaveFirst();
  assert.deepEqual(timers.active, [start + 5_000]);
  leaveSecond();
  assert.deepEqual(timers.active, []);
  leaveSecond();
  assert.deepEqual(timers.active, []);
});

test("an unsubscribed listener is not notified", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const calls = [];
  const leave = clock.subscribe(now => calls.push(now), now => now + 1_000);
  clock.subscribe(() => {}, now => now + 1_000);
  leave();
  timers.advance(1_000);
  assert.deepEqual(calls, []);
});

test("rescheduling after a subscriber's boundary changes keeps a single timer", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  let next = start + 60_000;
  clock.subscribe(() => {}, () => next);
  assert.deepEqual(timers.active, [start + 60_000]);
  next = start + 2_000;
  clock.reschedule();
  assert.deepEqual(timers.active, [start + 2_000]);
  clock.reschedule();
  assert.deepEqual(timers.active, [start + 2_000], "an unchanged boundary is not set twice");
  next = null;
  clock.reschedule();
  assert.deepEqual(timers.active, []);
});

test("a boundary already passed fires at once instead of being lost", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const seen = [];
  let next = start - 5;
  clock.subscribe(now => { seen.push(now); next = null; }, () => next);
  assert.deepEqual(timers.active, [start]);
  timers.advance(0);
  assert.deepEqual(seen, [start]);
  assert.deepEqual(timers.active, []);
});

test("notify wakes every subscriber now, for example when the app returns to the foreground", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const seen = [];
  clock.subscribe(now => seen.push(["a", now]), () => null);
  clock.subscribe(now => seen.push(["b", now]), now => now + 10_000);
  timers.advance(3_000);
  clock.notify();
  assert.deepEqual(seen, [["a", start + 3_000], ["b", start + 3_000]]);
  assert.deepEqual(timers.active, [start + 13_000]);
});

test("one failing listener does not stop the others or the next boundary", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const seen = [];
  clock.subscribe(() => { throw new Error("render failed"); }, now => now + 1_000);
  clock.subscribe(now => seen.push(now), now => now + 1_000);
  timers.advance(1_000);
  assert.deepEqual(seen, [start + 1_000]);
  assert.deepEqual(timers.active, [start + 2_000]);
});

test("the clock reads the current time from its timers", () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  timers.advance(1234);
  assert.equal(clock.now(), timers.now());
});
