import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createObserver } from './observer';
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import type { Observation, StoredOperation } from './model';

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
      '7d9c570c36bcad4db9ef816c0b704c5b0d01d12c7522b215cdfbbfc160c86648',
      '9fa0456c8d59db1297e540db98993d8d23e34dbfb4a487843334926447ece70b']) {
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

test('opening a session removes closed or long-idle launches of that conversation only', async () => {
  const f = await fixture();
  try {
    const day = 24 * 60 * 60_000;
    // File times before 1970 are not applied on Windows; use a present-day clock.
    const present = Date.now();
    f.advance(present);
    const ago = (ms: number) => new Date(1_000_000 + present - ms);
    const launch = async (id: string, ledger: object, ageMs: number) => {
      const directory = join(f.parent, id);
      await mkdir(join(directory, 'mod'), { recursive: true });
      await writeFile(join(directory, 'ledger.json'), JSON.stringify(ledger));
      await utimes(join(directory, 'ledger.json'), ago(ageMs), ago(ageMs));
    };
    await launch('closed', { ...f.ledger, closed: true }, 0);
    await launch('idle', { ...f.ledger }, day + 1);
    await launch('never-started', {}, day + 1);
    await launch('recent', { ...f.ledger }, day - 60_000);
    await mkdir(join(f.parent, 'preparing'));
    await mkdir(join(f.parent, 'abandoned'));
    await utimes(join(f.parent, 'abandoned'), ago(day + 1), ago(day + 1));
    const other = await f.observer.prepareSession({ ...f.request, agentId: 'b' }, true);
    await f.observer.prepareSession(f.request, true);
    const current = JSON.parse(await readFile(join(f.parent, 'current.json'), 'utf8')).launchId;
    const remaining = (await readdir(f.parent)).filter(name => name !== 'current.json').sort();
    assert.deepEqual(remaining, [current, f.manifest.launchId, 'preparing', 'receipts', 'recent'].sort());
    assert(other.env.CLAUDE_CODE_PLUGIN_DIRS.includes('observers'));
    assert.equal((await readdir(join(f.home, 'plugin-data/auto-compact-for-claude/observers'))).length, 2);
  } finally { await f.close(); }
});

test('durable receipts survive closed-launch pruning and require every native identity field', async () => {
  const f = await fixture();
  try {
    const operation = await f.observer.prepare(f.agent, false, 1_030_000, 'caller-request');
    assert.equal(operation.id, 'caller-request');
    const path = join(f.parent, 'receipts', 'caller-request.json');
    const receipt = { id: operation.id, launchId: operation.launchId, generation: operation.generation,
      sessionId: operation.sessionId, revision: operation.revision, status: 'completed', reason: null, observedAt: 1_000_001 };
    await writeFile(path, JSON.stringify(receipt));
    f.ledger.closed = true; await f.save();
    await f.observer.prepareSession(f.request, true);
    assert.equal((await f.observer.receipt('a', operation))?.status, 'completed');
    for (const patch of [{ id: 'foreign' }, { launchId: 'foreign' }, { generation: 'foreign' },
      { revision: operation.revision + 1 }, { sessionId: 'foreign' }]) {
      await writeFile(path, JSON.stringify({ ...receipt, ...patch }));
      assert.equal(await f.observer.receipt('a', operation), null);
    }
    await writeFile(path, '{partial');
    assert.equal(await f.observer.receipt('a', operation), null);
    await writeFile(path, JSON.stringify(receipt));
    assert.equal((await f.observer.receipt('a', operation))?.status, 'completed');
  } finally { await f.close(); }
});

test('receipt cleanup protects retained work, collects old orphans and never follows directory links', async () => {
  const f = await fixture();
  try {
    const receipts = join(f.parent, 'receipts');
    const old = { id: 'orphan', launchId: f.manifest.launchId, generation: 'generation-1', sessionId: 'native-a',
      revision: 1, status: 'completed', reason: null, observedAt: 100 };
    await writeFile(join(receipts, 'orphan.json'), JSON.stringify(old));
    await writeFile(join(receipts, 'pending.json'), '{}');
    await writeFile(join(receipts, 'partial.json'), '{');
    await writeFile(join(receipts, 'recent.json'), JSON.stringify({ ...old, id: 'recent', observedAt: 1001 }));
    for (const file of ['pending.json', 'partial.json']) await utimes(join(receipts, file), 0, 0);
    const retained = [{ id: 'pending', agentId: 'a' }] as StoredOperation[];
    await f.observer.sweepReceipts(retained, 1000);
    assert.deepEqual((await readdir(receipts)).sort(), ['pending.json', 'recent.json']);
    // A late save from an older observer is collected using observedAt, not its fresh mtime.
    await writeFile(join(receipts, 'orphan.json'), JSON.stringify(old));
    await f.observer.sweepReceipts(retained, 1000);
    assert.deepEqual((await readdir(receipts)).sort(), ['pending.json', 'recent.json']);
    await f.observer.removeReceipt('a', 'pending');
    await f.observer.removeReceipt('a', 'pending');
    await f.observer.removeReceipt('missing-agent', 'missing');
    // Windows junctions work without the optional file-symlink privilege.
    const external = join(f.home, 'external'); await mkdir(external);
    await writeFile(join(external, 'valuable.json'), '{}');
    await rm(receipts, { recursive: true });
    await symlink(external, receipts, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.observer.removeReceipt('a', 'valuable'), /Unsafe/);
    await assert.rejects(f.observer.sweepReceipts([], Infinity), /Unsafe/);
    assert.equal(await readFile(join(external, 'valuable.json'), 'utf8'), '{}');
  } finally { await f.close(); }
});
