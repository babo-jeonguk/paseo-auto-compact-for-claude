import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { acquireNativeSlot } from './simulation/execution.mjs';
import { cleanupScope } from './support/scope.ts';

test('independent native runs cannot share a machine slot; cleanup permits the next run', async (t) => {
  const directory = join(await cleanupScope(t).folder('compact-slot-'), 'lock');
  const release = await acquireNativeSlot(directory);
  await assert.rejects(acquireNativeSlot(directory), /Another native test owns/);
  await release();
  await (await acquireNativeSlot(directory))();
});
