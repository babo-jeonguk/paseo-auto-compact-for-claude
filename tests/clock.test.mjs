import assert from "node:assert/strict";
import { test } from "node:test";
import { createSharedClock } from "../client/clock.ts";
import { fakeTimers } from "./support/timers.ts";

test("controls showing countdowns share one timer set for the earliest boundary", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  clock.subscribe(() => {}, now => now + 30_000);
  clock.subscribe(() => {}, now => now + 1_000);
  assert.deepEqual(timers.dueTimes, [start + 1_000]);
});

test("a boundary notifies only the controls whose own boundary arrived", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const later = [], soon = [], idle = [];
  clock.subscribe(now => later.push(now), now => now < start + 30_000 ? start + 30_000 : null);
  clock.subscribe(now => soon.push(now), now => now < start + 1_000 ? start + 1_000 : null);
  clock.subscribe(now => idle.push(now), () => null);
  await timers.jump(999);
  assert.deepEqual([later, soon, idle], [[], [], []]);
  await timers.jump(1);
  assert.deepEqual(soon, [start + 1_000]);
  assert.deepEqual(later, [], "a control whose display has not changed does not render");
  await timers.jump(29_000);
  assert.deepEqual(later, [start + 30_000]);
  assert.deepEqual(soon, [start + 1_000]);
  assert.deepEqual(idle, [], "a control without a countdown never renders from the clock");
});

test("a countdown in its last minute does not make a minute countdown render every second", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const label = dueAt => now => {
    const remaining = dueAt - now;
    if (remaining <= 0) return null;
    return now + (remaining > 60_000 ? ((remaining - 1) % 60_000) + 1 : ((remaining - 1) % 1_000) + 1);
  };
  const seconds = [], minutes = [];
  clock.subscribe(now => seconds.push(now), label(start + 30_000));
  clock.subscribe(now => minutes.push(now), label(start + 10 * 60_000));
  await timers.jump(30_000);
  assert.equal(seconds.length, 30);
  assert.equal(minutes.length, 0);
});

test("after a boundary the clock reschedules to the next one", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const dueAt = start + 4 * 60_000 + 30_000;
  // A minute countdown: next boundary is where the displayed minute changes.
  const boundary = now => dueAt - now > 60_000 ? now + ((dueAt - now - 1) % 60_000) + 1 : null;
  const seen = [];
  clock.subscribe(now => seen.push(now), boundary);
  assert.deepEqual(timers.dueTimes, [start + 30_000]);
  await timers.jump(30_000);
  assert.deepEqual(timers.dueTimes, [start + 90_000]);
  await timers.jump(3 * 60_000 + 30_000);
  assert.deepEqual(seen, [start + 30_000, start + 90_000, start + 150_000, start + 210_000]);
  assert.deepEqual(timers.dueTimes, [], "no countdown left: no timer");
});

test("no subscriber with a boundary means no timer", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  clock.subscribe(() => {}, () => null);
  clock.subscribe(() => {}, () => null);
  assert.deepEqual(timers.dueTimes, []);
});

test("the timer is cleared when the last subscriber leaves, and only then", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const leaveFirst = clock.subscribe(() => {}, now => now + 1_000);
  const leaveSecond = clock.subscribe(() => {}, now => now + 5_000);
  leaveFirst();
  assert.deepEqual(timers.dueTimes, [start + 5_000]);
  leaveSecond();
  assert.deepEqual(timers.dueTimes, []);
  leaveSecond();
  assert.deepEqual(timers.dueTimes, []);
});

test("an unsubscribed listener is not notified", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const calls = [];
  const leave = clock.subscribe(now => calls.push(now), now => now + 1_000);
  clock.subscribe(() => {}, now => now + 1_000);
  leave();
  await timers.jump(1_000);
  assert.deepEqual(calls, []);
});

test("rescheduling after a subscriber's boundary changes keeps a single timer", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  let next = start + 60_000;
  clock.subscribe(() => {}, () => next);
  assert.deepEqual(timers.dueTimes, [start + 60_000]);
  next = start + 2_000;
  clock.reschedule();
  assert.deepEqual(timers.dueTimes, [start + 2_000]);
  clock.reschedule();
  assert.deepEqual(timers.dueTimes, [start + 2_000], "an unchanged boundary is not set twice");
  next = null;
  clock.reschedule();
  assert.deepEqual(timers.dueTimes, []);
});

test("a boundary already passed fires at once instead of being lost", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const seen = [];
  let next = start - 5;
  clock.subscribe(now => { seen.push(now); next = null; }, () => next);
  assert.deepEqual(timers.dueTimes, [start]);
  await timers.jump(0);
  assert.deepEqual(seen, [start]);
  assert.deepEqual(timers.dueTimes, []);
});

test("notify wakes every subscriber now, for example when the app returns to the foreground", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const seen = [];
  clock.subscribe(now => seen.push(["a", now]), () => null);
  clock.subscribe(now => seen.push(["b", now]), now => now + 10_000);
  await timers.jump(3_000);
  clock.notify();
  assert.deepEqual(seen, [["a", start + 3_000], ["b", start + 3_000]]);
  assert.deepEqual(timers.dueTimes, [start + 13_000]);
});

test("one failing listener does not stop the others or the next boundary", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const seen = [];
  clock.subscribe(() => { throw new Error("render failed"); }, now => now + 1_000);
  clock.subscribe(now => seen.push(now), now => now + 1_000);
  await timers.jump(1_000);
  assert.deepEqual(seen, [start + 1_000]);
  assert.deepEqual(timers.dueTimes, [start + 2_000]);
});

test("the clock reads the current time from its timers", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  await timers.jump(1234);
  assert.equal(clock.now(), timers.now());
});

test("a boundary that passed before its timer ran is still delivered after another control reschedules", async () => {
  const timers = fakeTimers();
  const clock = createSharedClock(timers);
  const start = timers.now();
  const deadline = start + 25_000;
  const stale = [];
  // A freshness deadline: only reported while it is still ahead.
  clock.subscribe(now => stale.push(now), now => deadline > now ? deadline : null);
  clock.subscribe(() => {}, now => now + 60_000);
  // The time moves past the deadline at once, as a busy event loop finds it,
  // and another control renders and reschedules before the overdue timer has
  // had its turn.
  const ticking = timers.tick(25_001);
  clock.reschedule();
  await ticking;
  await timers.jump(0);
  assert.deepEqual(stale, [start + 25_001], "the overdue control is told once");
  await timers.jump(60_000);
  assert.deepEqual(stale, [start + 25_001], "and not again after it was delivered");
});
