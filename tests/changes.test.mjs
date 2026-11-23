import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changes } from './support/changes.ts';

test('a wait ends at the change that makes its condition hold, or at once if it already holds', async () => {
  const signal = changes();
  let value = 0;
  await signal.until(() => value === 0);
  let ended = false;
  const waiting = signal.until(() => value === 2).then(() => { ended = true; });
  value = 1; signal.changed();
  await Promise.resolve();
  assert.equal(ended, false);
  value = 2; signal.changed();
  value = 3; // read at the change, so the brief state is not missed
  await waiting;
  assert.equal(ended, true);
});

test('a condition that throws fails the wait, not the caller of changed()', async () => {
  const signal = changes();
  let broken = false;
  const waiting = signal.until(() => { if (broken) throw new Error('broken'); return false; });
  broken = true;
  assert.doesNotThrow(() => signal.changed());
  await assert.rejects(waiting, /broken/);
});
