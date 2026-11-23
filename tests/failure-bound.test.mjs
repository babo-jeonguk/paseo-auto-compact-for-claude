import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { FAILURE_BOUND_MS, settledWithin } from './support/failure-bound.ts';

test('a settled wait passes its value or error through, and a stuck one ends null at the bound', async () => {
  assert.equal(await settledWithin(Promise.resolve('done')), 'done');
  await assert.rejects(settledWithin(Promise.reject(new Error('broken'))), /broken/);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const stuck = settledWithin(new Promise(() => {}));
    mock.timers.tick(FAILURE_BOUND_MS);
    assert.equal(await stuck, null);
  } finally { mock.timers.reset(); }
});
