import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeTimers, reusedHandleTimers, undefinedHandleTimers } from './support/timers.ts';

test('fake timers run only when moved on, earliest first, and report each one armed', async () => {
  let armed = 0;
  const timers = fakeTimers(() => { armed++; });
  const ran = [];
  timers.setTimeout(() => ran.push('late'), 300);
  timers.setTimeout(() => ran.push('early'), 100);
  const cleared = timers.setTimeout(() => ran.push('cleared'), 100);
  timers.clearTimeout(cleared);
  assert.equal(armed, 3);
  assert.equal(timers.pending, 2);
  assert.equal(timers.pendingWithin(100), 1);
  await timers.tick(99);
  assert.deepEqual(ran, []);
  await timers.tick(201);
  assert.deepEqual(ran, ['early', 'late']);
  assert.equal(timers.pending, 0);
});

test('a timer armed while others run waits for the next tick', async () => {
  const timers = fakeTimers();
  const ran = [];
  timers.setTimeout(() => { ran.push('first'); timers.setTimeout(() => ran.push('second'), 0); }, 10);
  await timers.tick(10);
  assert.deepEqual(ran, ['first']);
  await timers.tick(0);
  assert.deepEqual(ran, ['first', 'second']);
});

test('a due callback runs after the code that armed it has finished', async () => {
  const timers = fakeTimers();
  const steps = [];
  const armed = (async () => {
    timers.setTimeout(() => steps.push('fired'), 0);
    await Promise.resolve();
    steps.push('armer finished');
  })();
  await timers.tick(0);
  await armed;
  assert.deepEqual(steps, ['armer finished', 'fired']);
});

test('a timer cleared after its tick started but before it ran does not run', async () => {
  const timers = fakeTimers();
  const ran = [];
  const first = timers.setTimeout(() => ran.push('first'), 10);
  timers.setTimeout(() => ran.push('second'), 10);
  const ticking = timers.tick(10);
  timers.clearTimeout(first);
  await ticking;
  assert.deepEqual(ran, ['second']);
});

// Real timers run the microtasks a callback queued before the next callback
// due at the same time, so work it started can still cancel that one.
test('microtasks a due callback queued run before the next due callback', async () => {
  const timers = fakeTimers();
  const ran = [];
  let second;
  timers.setTimeout(() => {
    ran.push('first');
    void (async () => { await null; await null; timers.clearTimeout(second); })();
  }, 10);
  second = timers.setTimeout(() => ran.push('second'), 10);
  await timers.tick(10);
  assert.deepEqual(ran, ['first']);
  assert.equal(timers.pending, 0);
});

test('the time moves with each tick, at once, so callbacks that run late all see where the tick ended', async () => {
  const timers = fakeTimers(undefined, 5_000);
  const seen = [];
  timers.setTimeout(() => seen.push(timers.now()), 100);
  timers.setTimeout(() => seen.push(timers.now()), 300);
  assert.equal(timers.now(), 5_000);
  assert.deepEqual(timers.dueTimes, [5_100, 5_300]);
  const ticking = timers.tick(500);
  assert.equal(timers.now(), 5_500, 'the time has moved before any due callback runs');
  assert.equal(timers.pending, 2, 'and the due timers are still pending');
  await ticking;
  assert.deepEqual(seen, [5_500, 5_500]);
  assert.deepEqual(timers.dueTimes, []);
});

test('a jump runs each timer at its own due time, including those armed on the way', async () => {
  const timers = fakeTimers();
  const seen = [];
  const every = (ms) => timers.setTimeout(() => { seen.push(timers.now()); every(ms); }, ms);
  every(1_000);
  timers.setTimeout(() => seen.push(`once ${timers.now()}`), 2_500);
  await timers.jump(3_200);
  assert.deepEqual(seen, [1_000, 2_000, 'once 2500', 3_000]);
  assert.equal(timers.now(), 3_200);
  assert.deepEqual(timers.dueTimes, [4_000]);
});

test('a jump runs each callback on a later turn, so one can still clear the next', async () => {
  const timers = fakeTimers();
  const ran = [];
  let second;
  timers.setTimeout(() => {
    ran.push('first');
    void (async () => { await null; timers.clearTimeout(second); })();
  }, 10);
  second = timers.setTimeout(() => ran.push('second'), 20);
  const jumping = timers.jump(30);
  assert.deepEqual(ran, [], 'nothing runs within the turn that started the jump');
  await jumping;
  assert.deepEqual(ran, ['first']);
});

test('a jump past no timer still ends on a later turn, at the time it moved to', async () => {
  const timers = fakeTimers();
  let ended = false;
  const jumping = timers.jump(50).then(() => { ended = true; });
  await Promise.resolve();
  assert.equal(ended, false);
  await jumping;
  assert.equal(timers.now(), 50);
});

test('the handle fakes keep the forms bounded() must clear by: no handle, and a reused number', () => {
  const none = undefinedHandleTimers();
  assert.equal(none.setTimeout(() => {}, 10), undefined);
  none.clearTimeout(undefined);
  assert.deepEqual(none.cleared, [undefined]);

  const reused = reusedHandleTimers();
  const ran = [];
  assert.equal(reused.setTimeout(() => ran.push('first'), 10), 1);
  assert.equal(reused.setTimeout(() => ran.push('second'), 10), 2);
  reused.fire(1);
  assert.equal(reused.setTimeout(() => ran.push('third'), 10), 1, 'the lowest free number is reused');
  reused.clearTimeout(2);
  assert.equal(reused.pending, 1);
  reused.fire(1);
  assert.deepEqual(ran, ['first', 'third']);
});
