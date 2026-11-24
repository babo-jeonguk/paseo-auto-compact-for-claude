import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireNativeSlot } from './simulation/execution.mjs';

test('independent native runs cannot share a machine slot; cleanup permits the next run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'compact-slot-'));
  const directory = join(root, 'lock');
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireNativeSlot(directory);
  await assert.rejects(acquireNativeSlot(directory), /Another native test owns/);
  await release();
  await (await acquireNativeSlot(directory))();
});
