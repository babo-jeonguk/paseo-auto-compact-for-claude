import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { createObserver, QUERY_RESTARTED_REFUSAL } from './observer';
import { CLOCK_STEP_TOLERANCE_MS } from './deadline';
import { observerAsset } from './observer-assets.generated';
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import type { ExecutionContext, Observation, StoredOperation } from './model';
import { cleanupScope, type CleanupScope } from '../tests/support/scope';
import { createDurableWrites, type DurableFiles } from './durable';
import { createGateway } from './gateway';
import { Refusal } from './model';
import { Stopped } from './deadline';
import { SESSION_RESUME_REQUIRED } from '../shared/rpc';
import { heldFiles } from '../tests/support/files';
import { fakeTimers } from '../tests/support/timers';
import { drainer } from '../tests/support/drained';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';

async function fixture(scope: CleanupScope, files?: DurableFiles) {
  const home = await scope.folder('compact-observer-');
  let time = 1_000_000;
  const writes = createDurableWrites(files);
  const observer = createObserver({ home, now: () => time, writes });
  // A complete session-open request, which the observer must preserve.
  const request = { agentId: 'a', workspaceId: 'w', provider: 'claude',
    purpose: 'interactive', reason: 'create', cwd: home, title: 'Conversation',
    labels: { retained: 'yes' }, metadata: {}, background: false, tools: [], mcpServers: {},
    env: { CLAUDE_CODE_PLUGIN_DIRS: '/existing', OTHER: 'preserved' } } as PluginSessionOpenRequest & {
      readonly title: string; readonly labels: Readonly<Record<string, string>>;
    };
  const prepared = await observer.prepareSession(request, true);
  const parent = join(home, 'plugin-data/auto-compact-for-claude/observers',
    (await readdir(join(home, 'plugin-data/auto-compact-for-claude/observers')))[0]);
  const manifest = JSON.parse(await readFile(join(parent, 'current.json'), 'utf8'));
  const directory = join(parent, manifest.launchId);
  const ledger = { version: 1, launchId: manifest.launchId, generation: 'generation-1', sessionId: 'native-a',
    updatedAt: time, revision: 1, activeTurns: [] as string[], pendingInputs: 0,
    ordinaryEndedAt: time as number | null, ordinaryRevision: 1, clockEpoch: 0, transcriptPath: join(home, 'native-a.jsonl'),
    cacheRequest: { startedAt: time, model: 'claude-sonnet-4-6', policy: { ttl: null, source: 'default' } } as object | null,
    compact: null as null | { id: string; revision: number; status: string }, closed: false };
  const save = () => writeFile(join(directory, 'ledger.json'), JSON.stringify(ledger));
  await writeFile(ledger.transcriptPath, JSON.stringify({ type: 'assistant', sessionId: 'native-a',
    timestamp: new Date(time).toISOString(), message: { model: 'claude-sonnet-4-6', usage: {
      cache_read_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } } } }) + '\n');
  await save();
  const agent: Observation = { agentId: 'a', title: null, workspace: home, provider: 'claude',
    revision: new Date(time).toISOString(), tokens: 210_000, eligible: true, idle: true, sessionId: 'native-a' };
  return { home, request, prepared, observer, agent, ledger, save, directory, parent, manifest, writes,
    now: () => time, advance(ms: number) { time += ms; } };
}

test('observer session preparation preserves provider environment and ignores history/non-Claude sessions', async (t) => {
  const f = await fixture(cleanupScope(t));
  assert.equal(f.prepared.env.OTHER, 'preserved');
  assert.equal((f.prepared as typeof f.request).title, 'Conversation');
  assert.deepEqual((f.prepared as typeof f.request).labels, { retained: 'yes' });
  const launch = (await f.observer.read('a'))!.ledger!.launchId;
  assert.equal(f.observer.startedHere('a', launch), true);
  assert.equal(createObserver({ home: f.home, now: () => 1_000_000 }).startedHere('a', launch), false,
    'a later plugin instance did not start this launch');
  assert.equal(f.observer.startedHere('missing', launch), false);
  assert(f.prepared.env.CLAUDE_CODE_PLUGIN_DIRS.startsWith('/existing' + delimiter));
  assert.equal(await f.observer.prepareSession(f.request, false), f.request);
  const history = { ...f.request, purpose: 'history' as const };
  assert.equal(await f.observer.prepareSession(history, true), history);
  assert.equal(await f.observer.readiness(f.agent, 1_060_000), null);
  assert.match((await f.observer.readiness(f.agent, 4_600_000))!.detail, /exceeds/);
  f.advance(61_000);
  assert.match((await f.observer.readiness(f.agent))!.detail, /unavailable/);
});

// Observer builds that open sessions may still run: releases, and main for
// direct GitHub installs. Listing the current build here makes a change to the
// observer source fail the test below until its new build is added, and the
// build it replaces then stays checked as readable.
const READABLE_BUILDS = ['f8a02403e4f6c17e010ddda4d0385109fe8c480dfc379c9bb91d309671f87c7a',
  '61a0e12639e417cd28f7a651c789c00e10606bf994d960276f1916914eb3e6d4',
  'af6c6639f8c3058a73d5e982e308b69f5572fc6439a0c8fea61c1ca629ef4239',
  '8a6c0217779bc4f83c7029c8170c35da8d2ed8028622019f4a09808491dff90f',
  '7d9c570c36bcad4db9ef816c0b704c5b0d01d12c7522b215cdfbbfc160c86648',
  '9fa0456c8d59db1297e540db98993d8d23e34dbfb4a487843334926447ece70b',
  'ece7bf8ce5445aedb974f30472983b78c7358b8feea99d15c1ef2369d88a26e4',
  // v1.2.1
  '134e83d3751cca2f86c2ccda713162c7e739827df129e2020ab88a039c564e63',
  // main after #23 (query-restart refusal), installed by direct GitHub updates
  '35dc721b4f7cd02d1618f04fb9b9f856513ba21d07dc6abcac291911d94e8509',
  // v1.2.2
  '61b60834478e92325dc73fdb2b9235805997f990fe5ab8664bfef7ccc8f06d61',
  // main after the lint cleanup: why-comments and a named heartbeat only
  '4ab2a02a0d279eb0db390fa1462b83db78aa1dea74c8e12af7f07174eb7789b5',
  // main after per-preparation /compact checks (#35)
  '5a63cf937b60c41787f011a1384a22e8cabb02a67249d86b17f22fa6c1f2afe6'];

test('the current observer build is listed, so the build it replaces stays checked', () => {
  assert(READABLE_BUILDS.includes(observerAsset.version),
    `The observer source changed. Add its build ${observerAsset.version} to READABLE_BUILDS, and keep ` +
    'the build it replaces in compatibleBuilds in server/observer.ts unless the ledger contract changed.');
});

test('the compatible pre-fix observer stays readable during rollout; unknown builds stay rejected', async (t) => {
  const f = await fixture(cleanupScope(t));
  const manifestPath = join(f.parent, 'current.json');
  for (const build of READABLE_BUILDS) {
    await writeFile(manifestPath, JSON.stringify({ ...f.manifest, build }));
    assert(await f.observer.read('a'));
    f.ledger.pendingInputs = 1; await f.save();
    await assert.rejects(f.observer.prepare(f.agent, false, 1_030_000), /still working/);
  }
  await writeFile(manifestPath, JSON.stringify({ ...f.manifest, build: 'unknown-build' }));
  assert.equal(await f.observer.read('a'), null);
});

test('observer rejects mismatched sessions, busy native work, default TTL fallback and changed generations', async (t) => {
  const f = await fixture(cleanupScope(t));
  assert.match((await f.observer.readiness({ ...f.agent, sessionId: 'other' }))!.detail, /unavailable/);
  f.ledger.activeTurns = ['background']; await f.save();
  await assert.rejects(f.observer.prepare(f.agent, true, 1_030_000), /still working/);
  f.ledger.activeTurns = []; f.ledger.transcriptPath = '/missing-transcript'; await f.save();
  assert.equal(await f.observer.readiness(f.agent, 1_000_000 + 55 * 60_000), null);
  assert.equal((await f.observer.read('a'))?.ledger?.cache?.source, 'default');
  const manual = await f.observer.prepare(f.agent, false, 1_030_000);
  f.ledger.generation = 'reloaded'; await f.save();
  assert.equal(await f.observer.result('a', manual), null,
    'a generation change alone waits for a matching refusal or the observation deadline');
  await f.observer.prepareSession(f.request, true);
  const nextManifest = JSON.parse(await readFile(join(f.parent, 'current.json'), 'utf8'));
  await writeFile(join(f.parent, nextManifest.launchId, 'ledger.json'),
    JSON.stringify({ ...f.ledger, launchId: nextManifest.launchId }));
  assert.equal((await f.observer.result('a', manual))?.status, 'unknown',
    'a different launch cannot read the old request file');
});

test('a ledger written just before a WSL clock step back stays readable; a far-future ledger does not', async (t) => {
  const f = await fixture(cleanupScope(t));
  // A heartbeat saved at 1_001_800, then the system clock stepped back 1.8 s.
  f.ledger.updatedAt = 1_001_800; await f.save();
  assert(await f.observer.read('a'));
  assert.equal(await f.observer.readiness(f.agent, 1_060_000), null);
  const manual = await f.observer.prepare(f.agent, false, 1_030_000);
  assert.equal(manual.preparedAt, 1_000_000);
  f.ledger.updatedAt = 1_010_000; await f.save();
  assert(await f.observer.read('a'), 'the tolerance is inclusive');
  f.ledger.updatedAt = 1_010_001; await f.save();
  assert.equal(await f.observer.read('a'), null);
});

test('the observer and the server use the same clock-step tolerance', async () => {
  const source = await readFile(new URL('./observer-source.mjs', import.meta.url), 'utf8');
  assert.equal(Number(/const CLOCK_STEP_TOLERANCE_MS = ([\d_]+);/.exec(source)?.[1].replaceAll('_', '')),
    CLOCK_STEP_TOLERANCE_MS);
  assert.equal(/const QUERY_RESTARTED_REFUSAL = '([^']+)';/.exec(source)?.[1], QUERY_RESTARTED_REFUSAL);
});

test('native receipt must match operation and revision; settling preserves subsequent manual compact', async (t) => {
  const f = await fixture(cleanupScope(t));
  const operation = await f.observer.prepare(f.agent, true, 1_030_000);
  f.ledger.compact = { id: 'foreign', revision: 1, status: 'completed' }; await f.save();
  assert.equal(await f.observer.result('a', operation), null);
  f.ledger.compact = { id: operation.id, revision: 1, status: 'completed' }; await f.save();
  assert.equal((await f.observer.result('a', operation))?.status, 'completed');
  await f.observer.cancel(operation);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'request.json'), 'utf8')).status, 'settled');
  // Input after the command advances the ledger; the operation's own record still decides.
  f.ledger.revision++; await f.save();
  assert.equal((await f.observer.result('a', operation))?.status, 'completed');
  f.ledger.compact = { id: operation.id, revision: 1, status: 'running' }; await f.save();
  assert.equal(await f.observer.result('a', operation), null, 'still running is no answer yet');
  f.ledger.compact = { id: operation.id, revision: 1, status: 'completed' }; f.ledger.revision--; await f.save();
  const next = await f.observer.prepare(f.agent, true, 1_030_000);
  await f.observer.cancel(operation);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'request.json'), 'utf8')).id, next.id);
  // Once a durable receipt exists, release settles request.json even if later
  // activity replaced ledger.compact.
  await writeFile(join(f.parent, 'receipts', `${encodeURIComponent(next.id)}.json`), JSON.stringify({
    id: next.id, launchId: next.launchId, generation: 'generation-2', sessionId: next.sessionId,
    revision: 0, status: 'failed', reason: 'Claude query restarted before compaction ran',
    observedAt: 1_000_050, refusal: QUERY_RESTARTED_REFUSAL,
    prepared: { launchId: next.launchId, generation: next.generation, sessionId: next.sessionId, revision: next.revision },
  }));
  f.ledger.compact = null; await f.save();
  await f.observer.release('a', next, true);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'request.json'), 'utf8')).status, 'settled');
});

test('release caught in the middle of a ledger write still retires the request', async (t) => {
  const f = await fixture(cleanupScope(t));
  const ledgerPath = join(f.directory, 'ledger.json');
  const status = async () => JSON.parse(await readFile(join(f.directory, 'request.json'), 'utf8')).status;
  // Without a receipt, a sent request whose ledger cannot be read is cancelled,
  // as an unobserved send is.
  const unrecorded = await f.observer.prepare(f.agent, true, 1_030_000);
  await writeFile(ledgerPath, '');
  await f.observer.cancel(unrecorded);
  assert.equal(await status(), 'cancelled');
  // A durable receipt alone proves Claude consumed the request.
  await f.save();
  const recorded = await f.observer.prepare(f.agent, true, 1_030_000);
  await writeFile(join(f.parent, 'receipts', `${encodeURIComponent(recorded.id)}.json`), JSON.stringify({
    id: recorded.id, launchId: recorded.launchId, generation: recorded.generation, sessionId: recorded.sessionId,
    revision: recorded.revision, status: 'completed', reason: null, observedAt: 1_000_050,
  }));
  await writeFile(ledgerPath, '{"version":1,"launch');
  await f.observer.cancel(recorded);
  assert.equal(await status(), 'settled');
});

test('opening a session removes closed or long-idle launches of that conversation only', async (t) => {
  const f = await fixture(cleanupScope(t));
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
});

test('durable receipts survive closed-launch pruning and require every native identity field', async (t) => {
  const f = await fixture(cleanupScope(t));
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
});

test('receipt cleanup protects retained work, collects old orphans and never follows directory links', async (t) => {
  const f = await fixture(cleanupScope(t));
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
});

test('an observer that cannot be read is a fault, not an absent observer', async (t) => {
  const f = await fixture(cleanupScope(t));
  assert(await f.observer.read('a'));
  // Half-written ledger: thrown, so dispatch retries instead of treating it as gone.
  await writeFile(join(f.directory, 'ledger.json'), '{"version":1,');
  await assert.rejects(f.observer.read('a'), /could not be read/);
  await assert.rejects(f.observer.prepare(f.agent, false, Date.now() + 30_000, 'op-1'), /could not be read/);
  assert.deepEqual(await f.observer.readiness(f.agent),
    { reason: 'observer_unreadable', detail: 'Claude observer status unavailable; retrying' });
  // Content that parses but is not a ledger is malformed too, even JSON null.
  await writeFile(join(f.directory, 'ledger.json'), 'null');
  await assert.rejects(f.observer.read('a'), /could not be read/);
  await assert.rejects(f.observer.prepare(f.agent, false, Date.now() + 30_000, 'op-1'),
    (error: Error) => error.constructor.name !== 'Refusal' && /could not be read/.test(error.message));
  assert.equal((await f.observer.readiness(f.agent))?.reason, 'observer_unreadable');
  // A genuinely missing or stale observer is absence, and a refusal at dispatch.
  await f.save();
  f.advance(60_001);
  assert.equal(await f.observer.read('a'), null);
  await assert.rejects(f.observer.prepare(f.agent, false, Date.now() + 30_000, 'op-1'),
    (error: Error) => error.constructor.name === 'Refusal');
  await rm(join(f.parent, 'current.json'));
  assert.equal(await f.observer.read('a'), null);
});

test('every observer readiness answer carries its blocked reason code', async (t) => {
  const f = await fixture(cleanupScope(t));
  const code = async (agent = f.agent, dueAt?: number) => (await f.observer.readiness(agent, dueAt))?.reason;
  assert.equal(await f.observer.readiness(f.agent, 1_060_000), null);
  assert.equal(await code(f.agent, 4_600_000), 'idle_delay_exceeds_cache');
  assert.equal(await code({ ...f.agent, sessionId: 'other' }), 'observer_missing');
  f.ledger.pendingInputs = 1; await f.save();
  assert.equal(await code(), 'claude_working');
  f.ledger.pendingInputs = 0; f.ledger.ordinaryEndedAt = null; f.ledger.cacheRequest = null; await f.save();
  assert.equal(await code(), 'waiting_for_reply');
  f.ledger.ordinaryEndedAt = 1_000_000;
  f.ledger.cacheRequest = { startedAt: 1_000_000, model: 'claude-sonnet-4-6', policy: { ttl: null, source: 'default' } };
  f.ledger.updatedAt = 1_000_000 + 60 * 60_000; await f.save();
  f.advance(60 * 60_000);
  assert.equal(await code(), 'cache_window_passed');
  await writeFile(join(f.directory, 'ledger.json'), '{"version":1,');
  assert.equal(await code(), 'observer_unreadable');
  f.ledger.closed = true; await f.save();
  assert.equal(await code(), 'observer_missing');
});

test('a placeholder ledger is a starting observer until a turn completes after the launch was prepared', async (t) => {
  const f = await fixture(cleanupScope(t));
  // A freshly opened session: the observer has not written its first ledger yet.
  f.advance(5_000);
  await f.observer.prepareSession(f.request, true);
  const preparedAt = 1_005_000;
  const before = { ...f.agent, revision: new Date(preparedAt - 1).toISOString() };
  f.advance(30_000);
  assert.equal((await f.observer.readiness(before))?.reason, 'observer_starting');
  assert.equal((await f.observer.read('a'))?.ledger, null, 'a placeholder is neither a fault nor absence');
  // Starting is a fault at dispatch, retried until the send deadline, never a refusal.
  await assert.rejects(f.observer.prepare(before, false, 1_100_000),
    (error: Error) => error.constructor.name !== 'Refusal');
  // A turn that started after preparation and is still running proves nothing yet.
  const running = { ...f.agent, idle: false, revision: new Date(preparedAt + 1).toISOString() };
  assert.equal((await f.observer.readiness(running))?.reason, 'observer_starting');
  // Once that turn has finished, an attached observer would have written.
  const finished = { ...running, idle: true };
  assert.equal((await f.observer.readiness(finished))?.reason, 'observer_missing');
  await assert.rejects(f.observer.prepare(finished, false, 1_100_000),
    (error: Error) => error.constructor.name === 'Refusal');
  // The decision is read from disk, so a restarted plugin gives the same answers.
  const restarted = createObserver({ home: f.home, now: () => 1_035_000 });
  assert.equal((await restarted.readiness(before))?.reason, 'observer_starting');
  assert.equal((await restarted.readiness(finished))?.reason, 'observer_missing');
});

test('a placeholder from a launch prepared before preparation times were recorded uses its file time', async (t) => {
  const f = await fixture(cleanupScope(t));
  await f.observer.prepareSession(f.request, true);
  const manifestPath = join(f.parent, 'current.json');
  const { launchId, build } = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ launchId, build }));
  const present = Date.now();
  await utimes(join(f.parent, launchId, 'ledger.json'), new Date(present), new Date(present));
  const reader = createObserver({ home: f.home, now: () => present + 1_000 });
  assert.equal((await reader.readiness({ ...f.agent, revision: new Date(present - 1_000).toISOString() }))?.reason,
    'observer_starting');
  assert.equal((await reader.readiness({ ...f.agent, revision: new Date(present + 500).toISOString() }))?.reason,
    'observer_missing');
});

test('a confirmed query-restart refusal is accepted by both receipt and result; ambiguous or foreign records stay rejected', async (t) => {
  const f = await fixture(cleanupScope(t));
  const operation = await f.observer.prepare(f.agent, false, 1_030_000, 'restart-op');
  const path = join(f.parent, 'receipts', 'restart-op.json');
  const prepared = {
    launchId: operation.launchId, generation: operation.generation,
    sessionId: operation.sessionId, revision: operation.revision,
  };
  const validRefusal = {
    id: operation.id, launchId: operation.launchId, generation: 'generation-2',
    sessionId: operation.sessionId, revision: 0, status: 'failed',
    reason: 'Claude query restarted before compaction ran', observedAt: 1_000_050,
    refusal: QUERY_RESTARTED_REFUSAL, prepared,
  };
  await writeFile(path, JSON.stringify(validRefusal));
  const fromReceipt = await f.observer.receipt('a', operation);
  assert.equal(fromReceipt?.status, 'failed');
  assert.match(fromReceipt.detail, /query restarted/i);
  assert.equal(fromReceipt?.observedAt, 1_000_050);

  // The same rule applies to live ledger reads when the new generation writes compact.
  f.ledger.generation = 'generation-2';
  f.ledger.revision = 0;
  f.ledger.compact = {
    id: operation.id, revision: 0, status: 'failed',
    reason: 'Claude query restarted before compaction ran',
    refusal: QUERY_RESTARTED_REFUSAL, prepared,
  } as typeof f.ledger.compact;
  await f.save();
  const fromLedger = await f.observer.result('a', operation);
  assert.equal(fromLedger?.status, 'failed');
  assert.match(fromLedger.detail, /query restarted/i);

  // Reject ambiguous, unrelated, generic cancellation, or foreign-generation completion records.
  const rejected: Array<[string, Record<string, unknown>]> = [
    ['generic cancellation without refusal code', { refusal: undefined, prepared: undefined, reason: 'Reservation cancelled' }],
    ['unknown refusal code', { refusal: 'other_refusal' }],
    ['missing prepared identity', { prepared: undefined }],
    ['mismatched operation id', { id: 'other-op' }],
    ['mismatched receipt launchId', { launchId: 'other-launch' }],
    ['mismatched receipt sessionId', { sessionId: 'other-session' }],
    ['same generation is not a restart', { generation: operation.generation }],
    ['mismatched prepared launchId', { prepared: { ...prepared, launchId: 'other-launch' } }],
    ['mismatched prepared generation', { prepared: { ...prepared, generation: 'other-generation' } }],
    ['mismatched prepared sessionId', { prepared: { ...prepared, sessionId: 'other-session' } }],
    ['mismatched prepared revision', { prepared: { ...prepared, revision: operation.revision + 1 } }],
    ['foreign-generation completion', { status: 'completed', reason: null }],
    ['foreign-generation unknown', { status: 'unknown', reason: null }],
  ];
  for (const [name, patch] of rejected) {
    const candidate = { ...validRefusal, ...patch };
    await writeFile(path, JSON.stringify(candidate));
    assert.equal(await f.observer.receipt('a', operation), null, `receipt must reject: ${name}`);
    if (candidate.launchId === operation.launchId && candidate.generation !== operation.generation) {
      f.ledger.generation = String(candidate.generation);
      f.ledger.sessionId = String(candidate.sessionId);
      f.ledger.compact = {
        id: candidate.id, revision: candidate.revision, status: candidate.status,
        reason: candidate.reason, refusal: candidate.refusal, prepared: candidate.prepared,
      } as typeof f.ledger.compact;
      await f.save();
      assert.equal(await f.observer.result('a', operation), null, `result must reject: ${name}`);
    }
  }
});

const requestFile = async (directory: string) => JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));

test('each preparation of a request has its own identity, and retiring one never retires another', async (t) => {
  const f = await fixture(cleanupScope(t));
  const first = await f.observer.prepare(f.agent, false, 1_030_000, 'same-operation');
  const second = await f.observer.prepare(f.agent, false, 1_030_000, 'same-operation');
  assert.equal(typeof first.preparation, 'string');
  assert.notEqual(first.preparation, second.preparation, 'a retry of the same operation is a new preparation');
  assert.equal((await requestFile(f.directory)).preparation, second.preparation);
  // A late retirement of the earlier preparation, by the attempt or by release.
  await f.observer.cancel(first, false);
  await f.observer.release('a', { id: 'same-operation', launchId: first.launchId, preparation: first.preparation }, true);
  assert.equal((await requestFile(f.directory)).status, 'prepared');
  assert.equal((await requestFile(f.directory)).preparation, second.preparation);
  await f.observer.cancel(second, false);
  assert.deepEqual(await requestFile(f.directory),
    { id: 'same-operation', preparation: second.preparation, status: 'settled' },
    'the retired request still names the preparation it retired');
});

test('a request an earlier release prepared, without a preparation identity, is still retired by its operation', async (t) => {
  const f = await fixture(cleanupScope(t));
  await writeFile(join(f.directory, 'request.json'), JSON.stringify({ id: 'earlier', launchId: f.manifest.launchId,
    generation: 'generation-1', sessionId: 'native-a', revision: 1, preparedAt: 1_000_000, expiresAt: 1_030_000,
    requireCache: false, cacheDeadline: null, clockEpoch: 0, status: 'prepared' }));
  // Evidence an earlier release recorded names no preparation either.
  await f.observer.release('a', { id: 'earlier', launchId: f.manifest.launchId }, false);
  assert.equal((await requestFile(f.directory)).status, 'settled');
});

test('a retirement and a newer preparation of the same request land in the order they were asked for', async (t) => {
  const { files, holdRename } = heldFiles();
  const f = await fixture(cleanupScope(t), files);
  const drained = drainer();
  const first = await f.observer.prepare(f.agent, false, 1_030_000, 'same-operation');
  // The newer preparation's rename is issued and held at the file system.
  const held = holdRename(join(f.directory, 'request.json'));
  const preparing = f.observer.prepare(f.agent, false, 1_030_000, 'same-operation');
  await held.reached;
  // A late retirement of the earlier preparation, asked for after it, waits
  // for that rename to land rather than reading the request beneath it.
  let retired = false;
  const retiring = f.observer.cancel(first, false).then(() => { retired = true; });
  await drained();
  assert.equal(retired, false, 'the retirement waits for the preparation asked for before it');
  held.release();
  const second = await preparing;
  await retiring;
  const request = await requestFile(f.directory);
  assert.equal(request.status, 'prepared', 'the retirement cannot replace the newer preparation');
  assert.equal(request.preparation, second.preparation);
});

test('a delayed publication of an earlier launch cannot replace a newer active launch', async (t) => {
  const { files, holdRename } = heldFiles();
  const f = await fixture(cleanupScope(t), files);
  const drained = drainer();
  const manifestPath = join(f.parent, 'current.json');
  const held = holdRename(manifestPath);
  const earlier = f.observer.prepareSession(f.request, true);
  await held.reached;
  let opened = false;
  const later = f.observer.prepareSession(f.request, true).then(value => { opened = true; return value; });
  await drained();
  assert.equal(opened, false, 'the later launch waits for the earlier publication');
  held.release();
  await earlier;
  const newest = await later;
  const launch = newest.env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter).at(-1)!.split(/[\\/]/).at(-2);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).launchId, launch);
  assert.equal(f.observer.startedHere('a', launch!), true);
});

test('once durable writes close, no launch, preparation or retirement is written', async (t) => {
  const f = await fixture(cleanupScope(t));
  const prepared = await f.observer.prepare(f.agent, false, 1_030_000, 'operation');
  const manifest = await readFile(join(f.parent, 'current.json'), 'utf8');
  f.writes.close();
  await assert.rejects(f.observer.prepareSession(f.request, true), Stopped);
  await assert.rejects(f.observer.prepare(f.agent, false, 1_030_000, 'another'), Stopped);
  await assert.rejects(f.observer.cancel(prepared, false), Stopped);
  assert.equal(await readFile(join(f.parent, 'current.json'), 'utf8'), manifest);
  assert.equal((await requestFile(f.directory)).preparation, prepared.preparation);
  assert.equal((await requestFile(f.directory)).status, 'prepared');
  await f.writes.drain();
});

test('after a reload the gateway sends nothing to the launch the previous instance started, until a fresh launch opens', async (t) => {
  const scope = cleanupScope(t);
  const f = await fixture(scope);
  // The next plugin instance, on the same data directory.
  const next = createObserver({ home: f.home, now: f.now, writes: createDurableWrites() });
  const host = createGateway({ observer: next, now: f.now, timers: fakeTimers() });
  scope.defer(() => host.stop());
  let sends = 0;
  let sentOnce!: () => void;
  const sent = new Promise<void>(resolve => { sentOnce = resolve; });
  const agent = { id: 'a', provider: 'claude', cwd: f.home, title: null, labels: {}, status: 'idle', activeTurn: null,
    pendingPermissions: [], lastUserMessageAt: f.agent.revision, persistence: { sessionId: 'native-a' } };
  host.attach({ config: { get: async () => ({ config: { providers: {} } }) },
    agents: { ref: () => ({ refresh: async () => ({ agent }), send: async () => { sends++; sentOnce(); },
      timeline: { subscribe: () => ({ ready: Promise.resolve(), release() {} }) } }) },
  } as unknown as PluginHandlerContext['paseo']);
  // The worker's part in each attempt; nothing here is late, so its owner is handed nothing.
  const faults: unknown[] = [];
  const execution = (id: string): ExecutionContext => ({ id, sendBy: f.now() + 10_000, checkpoint: async () => {},
    current: () => true, fault: error => { faults.push(error); } });
  assert.equal((await host.gateway.refresh('a'))!.resumeRequired, true);
  await assert.rejects(host.gateway.compact('a', undefined, execution('stale')),
    (error: unknown) => error instanceof Refusal && error.message === SESSION_RESUME_REQUIRED);
  // An ordinary message reopens the session, which prepares a fresh launch.
  const reopened = await next.prepareSession(f.request, true);
  const launchId = reopened.env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter).at(-1)!.split(/[\\/]/).at(-2)!;
  await writeFile(join(f.parent, launchId, 'ledger.json'), JSON.stringify({ ...f.ledger, launchId }));
  assert.equal((await host.gateway.refresh('a'))!.resumeRequired, undefined);
  assert.equal(sends, 0);
  // The next request then goes to the fresh launch.
  const compacting = host.gateway.compact('a', undefined, execution('fresh'));
  await sent;
  assert.equal(sends, 1);
  const request = await requestFile(join(f.parent, launchId));
  assert.equal(request.status, 'prepared');
  assert.equal(request.launchId, launchId);
  // Stopping ends the attempt's observation; what was sent stays unconfirmed.
  host.stop();
  assert.equal((await compacting).status, 'unknown');
  assert.deepEqual(faults, []);
});

test('requests an earlier instance left prepared are retired as decided, once, and this instance leaves its own alone', async (t) => {
  const f = await fixture(cleanupScope(t));
  // Left prepared by the instance before a reload.
  const left = await f.observer.prepare(f.agent, false, 1_030_000, 'left');
  const next = createObserver({ home: f.home, now: f.now, writes: createDurableWrites() });
  const offered: unknown[] = [];
  const reported: unknown[] = [];
  const report = (error: unknown) => { reported.push(error); };
  await next.recoverPrepared(request => { offered.push(request); return { sent: false }; }, report);
  assert.deepEqual(offered, [{ id: 'left', preparation: left.preparation }]);
  assert.deepEqual(await requestFile(f.directory), { id: 'left', preparation: left.preparation, status: 'settled' });
  await next.recoverPrepared(() => assert.fail('a retired request is not offered again'), report);
  // A preparation this instance made is its own attempt's to retire.
  const own = await next.prepare(f.agent, false, 1_030_000, 'own');
  await next.recoverPrepared(() => assert.fail('an own preparation is not a leftover'), report);
  assert.equal((await requestFile(f.directory)).preparation, own.preparation);
  // A leftover still needed for observation stays prepared; one that may have
  // been sent is retired as sent, here without any record that Claude consumed it.
  const kept = await f.observer.prepare(f.agent, false, 1_030_000, 'observed');
  const later = createObserver({ home: f.home, now: f.now, writes: createDurableWrites() });
  await later.recoverPrepared(() => null, report);
  assert.equal((await requestFile(f.directory)).status, 'prepared');
  await later.recoverPrepared(() => ({ sent: true }), report);
  assert.deepEqual(await requestFile(f.directory), { id: 'observed', preparation: kept.preparation, status: 'cancelled' });
  assert.deepEqual(reported, []);
});

test('a native record from another preparation of the same operation settles nothing; one naming none still does', async (t) => {
  const f = await fixture(cleanupScope(t));
  const operation = await f.observer.prepare(f.agent, true, 1_030_000, 'operation');
  const native = { ...operation, preparation: operation.preparation };
  const receipt = (preparation?: string) => writeFile(join(f.parent, 'receipts', 'operation.json'), JSON.stringify({
    id: 'operation', launchId: operation.launchId, generation: operation.generation, sessionId: operation.sessionId,
    revision: operation.revision, status: 'failed', reason: 'Reservation expired', observedAt: 1_000_050,
    ...(preparation ? { preparation } : {}) }));
  await receipt('another-preparation');
  assert.equal(await f.observer.receipt('a', native), null);
  f.ledger.compact = { id: 'operation', revision: 1, status: 'failed', preparation: 'another-preparation' } as typeof f.ledger.compact;
  await f.save();
  assert.equal(await f.observer.result('a', native), null);
  await receipt(operation.preparation);
  assert.equal((await f.observer.receipt('a', native))?.status, 'failed');
  // An observer build from an earlier release records no preparation.
  await receipt();
  assert.equal((await f.observer.receipt('a', native))?.status, 'failed');
  f.ledger.compact = { id: 'operation', revision: 1, status: 'failed' }; await f.save();
  assert.equal((await f.observer.result('a', native))?.status, 'failed');
});

test('a retirement counts only a record of its own preparation as Claude having consumed the request', async (t) => {
  const f = await fixture(cleanupScope(t));
  const first = await f.observer.prepare(f.agent, true, 1_030_000, 'operation');
  // A /compact was checked against the first preparation and Claude ran it.
  await writeFile(join(f.parent, 'receipts', 'operation.json'), JSON.stringify({ id: 'operation',
    launchId: first.launchId, generation: first.generation, sessionId: first.sessionId, revision: first.revision,
    status: 'completed', reason: null, observedAt: 1_000_050, preparation: first.preparation }));
  f.ledger.compact = { id: 'operation', revision: 1, status: 'completed', preparation: first.preparation } as typeof f.ledger.compact;
  await f.save();
  // A retry, sent and never observed: its late /compact must stay refused.
  const second = await f.observer.prepare(f.agent, true, 1_030_000, 'operation');
  await f.observer.cancel(second, true);
  assert.deepEqual(await requestFile(f.directory), { id: 'operation', preparation: second.preparation, status: 'cancelled' });
  // Startup recovery retires a leftover by the same rule.
  const third = await f.observer.prepare(f.agent, true, 1_030_000, 'operation');
  const next = createObserver({ home: f.home, now: f.now, writes: createDurableWrites() });
  const reported: unknown[] = [];
  await next.recoverPrepared(() => ({ sent: true }), error => { reported.push(error); });
  assert.deepEqual(reported, []);
  assert.deepEqual(await requestFile(f.directory), { id: 'operation', preparation: third.preparation, status: 'cancelled' });
});

test('a live record of another preparation is no answer yet, whatever its revision', async (t) => {
  const f = await fixture(cleanupScope(t));
  const first = await f.observer.prepare(f.agent, true, 1_030_000, 'operation');
  const second = await f.observer.prepare(f.agent, true, 1_030_000, 'operation');
  f.ledger.compact = { id: 'operation', revision: 0, status: 'completed', preparation: first.preparation } as typeof f.ledger.compact;
  await f.save();
  assert.equal(await f.observer.result('a', second), null);
});

test('evidence naming no preparation, as an earlier release or a rollback left it, matches a record that names one', async (t) => {
  const f = await fixture(cleanupScope(t));
  const operation = await f.observer.prepare(f.agent, true, 1_030_000, 'operation');
  const { preparation, ...untagged } = operation;
  await writeFile(join(f.parent, 'receipts', 'operation.json'), JSON.stringify({ id: 'operation',
    launchId: operation.launchId, generation: operation.generation, sessionId: operation.sessionId,
    revision: operation.revision, status: 'failed', reason: 'Reservation expired', observedAt: 1_000_050, preparation }));
  assert.equal((await f.observer.receipt('a', untagged))?.status, 'failed');
  f.ledger.compact = { id: 'operation', revision: 1, status: 'failed', preparation } as typeof f.ledger.compact;
  await f.save();
  assert.equal((await f.observer.result('a', untagged))?.status, 'failed');
});

test('a request that does not validate is never rewritten by a retirement or recovery', async (t) => {
  const f = await fixture(cleanupScope(t));
  const operation = await f.observer.prepare(f.agent, false, 1_030_000, 'operation');
  const malformed = JSON.stringify({ ...await requestFile(f.directory), preparation: 5 });
  await writeFile(join(f.directory, 'request.json'), malformed);
  await assert.rejects(f.observer.cancel(operation, false));
  assert.equal(await readFile(join(f.directory, 'request.json'), 'utf8'), malformed);
  const next = createObserver({ home: f.home, now: f.now, writes: createDurableWrites() });
  const reported: unknown[] = [];
  await next.recoverPrepared(() => ({ sent: false }), error => { reported.push(error); });
  assert.equal(reported.length, 1);
  assert.equal(await readFile(join(f.directory, 'request.json'), 'utf8'), malformed);
});

// A leftover prepared request in conversation `agentId`'s active launch.
async function leftover(f: Awaited<ReturnType<typeof fixture>>, agentId: string) {
  const opened = await f.observer.prepareSession({ ...f.request, agentId }, true);
  const directory = opened.env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter).at(-1)!.split(/[\\/]mod$/)[0];
  await writeFile(join(directory, 'request.json'), JSON.stringify({ id: `${agentId}-operation`,
    preparation: `${agentId}-preparation`, status: 'prepared' }));
  return directory;
}

test('recovery reports each conversation it cannot read and still retires the others', async (t) => {
  const f = await fixture(cleanupScope(t));
  const good = await leftover(f, 'good');
  for (const agentId of ['b', 'c']) {
    const directory = await leftover(f, agentId);
    await writeFile(join(directory, '..', 'current.json'), '{ unreadable');
  }
  const next = createObserver({ home: f.home, now: f.now, writes: createDurableWrites() });
  const reported: unknown[] = [];
  await next.recoverPrepared(() => ({ sent: false }), error => { reported.push(error); });
  assert.equal(reported.length, 2, 'each failure is reported on its own');
  assert(reported.every(error => error instanceof SyntaxError));
  assert.equal((await requestFile(good)).status, 'settled');
});

test('a conversation whose retirement is held does not hold another conversation\'s', async (t) => {
  const { files, holdRename } = heldFiles();
  const f = await fixture(cleanupScope(t));
  const first = await leftover(f, 'b');
  const second = await leftover(f, 'c');
  const next = createObserver({ home: f.home, now: f.now, writes: createDurableWrites(files) });
  const heldFirst = holdRename(join(first, 'request.json'));
  const heldSecond = holdRename(join(second, 'request.json'));
  const reported: unknown[] = [];
  const recovering = next.recoverPrepared(() => ({ sent: false }), error => { reported.push(error); });
  // Both reach their own write while neither has landed.
  await Promise.all([heldFirst.reached, heldSecond.reached]);
  heldSecond.release();
  await heldSecond.landed;
  assert.equal((await requestFile(second)).status, 'settled');
  assert.equal((await requestFile(first)).status, 'prepared');
  heldFirst.release();
  await recovering;
  assert.equal((await requestFile(first)).status, 'settled');
  assert.deepEqual(reported, []);
});

test('across a reload, a retirement the stopped instance had issued lands before the next instance prepares the same request', async (t) => {
  const { files, holdRename } = heldFiles();
  const f = await fixture(cleanupScope(t), files);
  const drained = drainer();
  const first = await f.observer.prepare(f.agent, false, 1_030_000, 'operation');
  // A late retirement, issued and held at the file system.
  const held = holdRename(join(f.directory, 'request.json'));
  void f.observer.cancel(first, true).catch(() => {});
  await held.reached;
  // The host stops the plugin (its writes close, then drain) and starts the
  // next instance only once that stop has ended.
  f.writes.close();
  let stopped = false;
  const stopping = f.writes.drain().then(() => { stopped = true; });
  await drained();
  assert.equal(stopped, false, 'the stop waits for the issued retirement');
  held.release();
  await stopping;
  const next = createObserver({ home: f.home, now: f.now, writes: createDurableWrites() });
  await next.recoverPrepared(() => assert.fail('the stopped instance already retired its request'),
    () => assert.fail('nothing fails'));
  const second = await next.prepare(f.agent, false, 1_030_000, 'operation');
  const request = await requestFile(f.directory);
  assert.equal(request.status, 'prepared', 'the next instance\'s preparation of the same request is intact');
  assert.equal(request.preparation, second.preparation);
});

test('across a reload, a launch publication the stopped instance had issued lands before the next instance opens one', async (t) => {
  const { files, holdRename } = heldFiles();
  const f = await fixture(cleanupScope(t), files);
  const drained = drainer();
  const manifestPath = join(f.parent, 'current.json');
  const held = holdRename(manifestPath);
  void f.observer.prepareSession(f.request, true).catch(() => {});
  await held.reached;
  f.writes.close();
  let stopped = false;
  const stopping = f.writes.drain().then(() => { stopped = true; });
  await drained();
  assert.equal(stopped, false, 'the stop waits for the issued publication');
  held.release();
  await stopping;
  const next = createObserver({ home: f.home, now: f.now, writes: createDurableWrites() });
  const reopened = await next.prepareSession(f.request, true);
  const launchId = reopened.env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter).at(-1)!.split(/[\\/]/).at(-2)!;
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).launchId, launchId,
    'the earlier publication cannot replace the next instance\'s launch');
});

test('a retirement leaves a request that is no longer prepared, or in a state it does not know, as it is', async (t) => {
  const f = await fixture(cleanupScope(t));
  const operation = await f.observer.prepare(f.agent, false, 1_030_000, 'operation');
  for (const status of ['settled', 'future-state', undefined]) {
    const record = JSON.stringify({ id: 'operation', preparation: operation.preparation, ...(status ? { status } : {}) });
    await writeFile(join(f.directory, 'request.json'), record);
    await f.observer.cancel(operation, true);
    await f.observer.release('a', operation, true);
    assert.equal(await readFile(join(f.directory, 'request.json'), 'utf8'), record, `${status}`);
  }
});
