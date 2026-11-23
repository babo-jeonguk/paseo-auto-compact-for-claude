import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeTimers } from './support/timers.ts';

test('fake timers run only when moved on, earliest first, and report each one armed', () => {
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
  timers.tick(99);
  assert.deepEqual(ran, []);
  timers.tick(201);
  assert.deepEqual(ran, ['early', 'late']);
  assert.equal(timers.pending, 0);
});

test('a timer armed while others run waits for the next tick', () => {
  const timers = fakeTimers();
  const ran = [];
  timers.setTimeout(() => { ran.push('first'); timers.setTimeout(() => ran.push('second'), 0); }, 10);
  timers.tick(10);
  assert.deepEqual(ran, ['first']);
  timers.tick(0);
  assert.deepEqual(ran, ['first', 'second']);
});
