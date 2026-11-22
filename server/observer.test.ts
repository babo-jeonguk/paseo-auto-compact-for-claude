import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createObserver, QUERY_RESTARTED_REFUSAL } from './observer';
import { CLOCK_STEP_TOLERANCE_MS } from './deadline';
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import type { Observation, StoredOperation } from './model';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'compact-observer-'));
  let time = 1_000_000;
  const observer = createObserver({ home, now: () => time });
  // The additive 0.14 fields are harmless to 0.12/0.13 and verify that the
  // observer preserves the complete session-open request across SDK versions.
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
  return { home, request, prepared, observer, agent, ledger, save, directory, parent, manifest,
    advance(ms: number) { time += ms; }, close: () => rm(home, { recursive: true, force: true }) };
}

test('observer session preparation preserves provider environment and ignores history/non-Claude sessions', async () => {
  const f = await fixture();
  try {
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
  } finally { await f.close(); }
});

test('the compatible pre-fix observer stays readable during rollout; unknown builds stay rejected', async () => {
  const f = await fixture();
  try {
    const manifestPath = join(f.parent, 'current.json');
    for (const build of ['af6c6639f8c3058a73d5e982e308b69f5572fc6439a0c8fea61c1ca629ef4239',
      '8a6c0217779bc4f83c7029c8170c35da8d2ed8028622019f4a09808491dff90f',
      '7d9c570c36bcad4db9ef816c0b704c5b0d01d12c7522b215cdfbbfc160c86648',
      '9fa0456c8d59db1297e540db98993d8d23e34dbfb4a487843334926447ece70b',
      'ece7bf8ce5445aedb974f30472983b78c7358b8feea99d15c1ef2369d88a26e4',
      // v1.2.1
      '134e83d3751cca2f86c2ccda713162c7e739827df129e2020ab88a039c564e63',
      // main after #23 (query-restart refusal), installed by direct GitHub updates
      '35dc721b4f7cd02d1618f04fb9b9f856513ba21d07dc6abcac291911d94e8509']) {
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
  } finally { await f.close(); }
});

test('a ledger written just before a WSL clock step back stays readable; a far-future ledger does not', async () => {
  const f = await fixture();
  try {
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
  } finally { await f.close(); }
});

test('the observer and the server use the same clock-step tolerance', async () => {
  const source = await readFile(new URL('./observer-source.mjs', import.meta.url), 'utf8');
  assert.equal(Number(/const CLOCK_STEP_TOLERANCE_MS = ([\d_]+);/.exec(source)?.[1].replaceAll('_', '')),
    CLOCK_STEP_TOLERANCE_MS);
  assert.equal(/const QUERY_RESTARTED_REFUSAL = '([^']+)';/.exec(source)?.[1], QUERY_RESTARTED_REFUSAL);
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

test('an observer that cannot be read is a fault, not an absent observer', async () => {
  const f = await fixture();
  try {
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
  } finally { await f.close(); }
});

test('every observer readiness answer carries its blocked reason code', async () => {
  const f = await fixture();
  try {
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
  } finally { await f.close(); }
});

test('a placeholder ledger is a starting observer until a turn completes after the launch was prepared', async () => {
  const f = await fixture();
  try {
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
  } finally { await f.close(); }
});

test('a placeholder from a launch prepared before preparation times were recorded uses its file time', async () => {
  const f = await fixture();
  try {
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
  } finally { await f.close(); }
});

test('a confirmed query-restart refusal is accepted by both receipt and result; ambiguous or foreign records stay rejected', async () => {
  const f = await fixture();
  try {
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
    assert.match(fromReceipt!.detail, /query restarted/i);
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
    assert.match(fromLedger!.detail, /query restarted/i);

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
  } finally { await f.close(); }
});
