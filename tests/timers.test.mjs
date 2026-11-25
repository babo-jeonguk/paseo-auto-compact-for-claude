import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeTimers } from './support/timers.ts';

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
