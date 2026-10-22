import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createObserver } from './observer';
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import type { Observation } from './model';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'compact-observer-'));
  let time = 1_000_000;
  const observer = createObserver({ home, now: () => time });
  const request: PluginSessionOpenRequest = { agentId: 'a', workspaceId: 'w', provider: 'claude',
    purpose: 'interactive', reason: 'create', cwd: home, env: { CLAUDE_CODE_PLUGIN_DIRS: '/existing', OTHER: 'preserved' } };
  const prepared = await observer.prepareSession(request, true);
  const parent = join(home, 'plugin-data/auto-compact-for-claude/observers',
    (await readdir(join(home, 'plugin-data/auto-compact-for-claude/observers')))[0]);
  const manifest = JSON.parse(await readFile(join(parent, 'current.json'), 'utf8'));
  const directory = join(parent, manifest.launchId);
  const ledger = { version: 1, launchId: manifest.launchId, generation: 'generation-1', sessionId: 'native-a',
    updatedAt: time, revision: 1, activeTurns: [] as string[], pendingInputs: 0,
    ordinaryEndedAt: time, ordinaryRevision: 1, clockEpoch: 0, transcriptPath: join(home, 'native-a.jsonl'),
    cacheRequest: { startedAt: time, model: 'claude-sonnet-4-6', policy: { ttl: null, source: 'default' } },
    compact: null as null | { id: string; revision: number; status: string }, closed: false };
  const save = () => writeFile(join(directory, 'ledger.json'), JSON.stringify(ledger));
  await writeFile(ledger.transcriptPath, JSON.stringify({ type: 'assistant', sessionId: 'native-a',
    timestamp: new Date(time).toISOString(), message: { model: 'claude-sonnet-4-6', usage: {
      cache_read_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } } } }) + '\n');
  await save();
  const agent: Observation = { agentId: 'a', title: null, workspace: home, provider: 'claude',
    revision: new Date(time).toISOString(), tokens: 210_000, eligible: true, idle: true, sessionId: 'native-a' };
  return { home, request, prepared, observer, agent, ledger, save, directory, parent, manifest,
    advance(ms: number) { time += ms; }, close: () => rm(home, { recursive: true, force: true }) };
}

test('observer session preparation preserves provider environment and ignores history/non-Claude sessions', async () => {
  const f = await fixture();
  try {
    assert.equal(f.prepared.env.OTHER, 'preserved');
    assert(f.prepared.env.CLAUDE_CODE_PLUGIN_DIRS.startsWith('/existing' + delimiter));
    assert.equal(await f.observer.prepareSession(f.request, false), f.request);
    const history = { ...f.request, purpose: 'history' as const };
    assert.equal(await f.observer.prepareSession(history, true), history);
    assert.equal(await f.observer.readiness(f.agent, 1_060_000), null);
    assert.match((await f.observer.readiness(f.agent, 4_600_000))!, /exceeds/);
    f.advance(61_000);
    assert.match((await f.observer.readiness(f.agent))!, /unavailable/);
  } finally { await f.close(); }
});

test('the compatible pre-fix observer stays readable during rollout; unknown builds stay rejected', async () => {
  const f = await fixture();
  try {
    const manifestPath = join(f.parent, 'current.json');
    for (const build of ['af6c6639f8c3058a73d5e982e308b69f5572fc6439a0c8fea61c1ca629ef4239',
      '8a6c0217779bc4f83c7029c8170c35da8d2ed8028622019f4a09808491dff90f',
      '7d9c570c36bcad4db9ef816c0b704c5b0d01d12c7522b215cdfbbfc160c86648']) {
      await writeFile(manifestPath, JSON.stringify({ ...f.manifest, build }));
      assert(await f.observer.read('a'));
      f.ledger.pendingInputs = 1; await f.save();
      await assert.rejects(f.observer.prepare(f.agent, false, 1_030_000), /still working/);
    }
    await writeFile(manifestPath, JSON.stringify({ ...f.manifest, build: 'unknown-build' }));
    assert.equal(await f.observer.read('a'), null);
  } finally { await f.close(); }
});

test('observer rejects mismatched sessions, busy native work, default TTL fallback and changed generations', async () => {
  const f = await fixture();
  try {
    assert.match((await f.observer.readiness({ ...f.agent, sessionId: 'other' }))!, /unavailable/);
    f.ledger.activeTurns = ['background']; await f.save();
    await assert.rejects(f.observer.prepare(f.agent, true, 1_030_000), /still working/);
    f.ledger.activeTurns = []; f.ledger.transcriptPath = '/missing-transcript'; await f.save();
    assert.equal(await f.observer.readiness(f.agent, 1_000_000 + 55 * 60_000), null);
    assert.equal((await f.observer.read('a'))?.ledger.cache?.source, 'default');
    const manual = await f.observer.prepare(f.agent, false, 1_030_000);
    f.ledger.generation = 'reloaded'; await f.save();
    assert.equal((await f.observer.result('a', manual))?.status, 'unknown');
  } finally { await f.close(); }
});

test('native receipt must match operation and revision; settling preserves subsequent manual compact', async () => {
  const f = await fixture();
  try {
    const operation = await f.observer.prepare(f.agent, true, 1_030_000);
    f.ledger.compact = { id: 'foreign', revision: 1, status: 'completed' }; await f.save();
    assert.equal(await f.observer.result('a', operation), null);
    f.ledger.compact = { id: operation.id, revision: 1, status: 'completed' }; await f.save();
    assert.equal((await f.observer.result('a', operation))?.status, 'completed');
    await f.observer.cancel(operation);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'request.json'), 'utf8')).status, 'settled');
    f.ledger.revision++; await f.save();
    assert.equal((await f.observer.result('a', operation))?.status, 'unknown');
    const next = await f.observer.prepare(f.agent, true, 1_030_000);
    await f.observer.cancel(operation);
    assert.equal(JSON.parse(await readFile(join(f.directory, 'request.json'), 'utf8')).id, next.id);
  } finally { await f.close(); }
});
