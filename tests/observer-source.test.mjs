import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerObserver } from '../server/observer-source.mjs';

function fixture(env = {}, settings = {}) {
  let time = 1_000_000;
  const hooks = new Map(), files = new Map();
  let heartbeat;
  const configuration = { launchId: 'launch-1', ledger: '/ledger', request: '/request' };
  const $ = { clock: { now: async () => time, every: (_ms, fn) => { heartbeat = fn; return { cancel() { heartbeat = null; } }; } },
    fs: { write: async (p, v) => files.set(p, v), read: async p => files.get(p) ?? '{}' },
    session: { id: async () => 'native-1' }, env: { get: async name => env[name] },
    settings: { read: async () => settings } };
  registerObserver((name, fn) => { hooks.set(name, fn); return { catch() {} }; }, configuration);
  const event = (name, input = {}) => hooks.get(name)($, input, async () => ({}));
  const ledger = () => JSON.parse(files.get('/ledger'));
  const request = (overrides = {}) => {
    const state = ledger();
    files.set('/request', JSON.stringify({ id: 'operation-1', launchId: state.launchId,
      generation: state.generation, sessionId: state.sessionId, revision: state.revision,
      status: 'prepared', requireCache: true, cacheDeadline: time + 3_600_000, clockEpoch: state.clockEpoch,
      preparedAt: time, expiresAt: time + 30_000, ...overrides }));
  };
  const usage = { input_tokens: 100, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
  const step = async (turnId = 'user-1') => {
    const generator = hooks.get('turn.step')($, { turnId }, async function* () { return { usage }; });
    while (!(await generator.next()).done) {}
  };
  return { event, step, ledger, request, files,
    advance(ms) { time += ms; },
    async start() { await event('session.start'); },
    async ordinary(reported = usage, responseDelay = 0) {
      await event('prompt.submit', { text: 'ordinary input' });
      await event('turn.start', { text: 'ordinary input', turnId: 'user-1' });
      const generator = hooks.get('turn.step')($, { turnId: 'user-1' }, async function* () {
        for (let elapsed = 0; elapsed < responseDelay; elapsed += 5000) {
          time += Math.min(5000, responseDelay - elapsed);
          await heartbeat?.();
        }
        return { usage: reported };
      });
      while (!(await generator.next()).done) {}
      await event('turn.complete', { turnId: 'user-1', isAborted: false, reason: 'answer' });
    },
  };
}

test('observer records native ordinary completion, request-time cache evidence and no message text', async () => {
  const f = fixture(); await f.start(); await f.ordinary(undefined, 60_000);
  assert.equal(f.ledger().cacheRequest.startedAt, 1_000_000);
  assert.equal(f.ledger().ordinaryEndedAt, 1_060_000);
  assert.equal(f.ledger().ordinaryRevision, 1);
  assert.deepEqual(f.ledger().activeTurns, []);
  assert(!f.files.get('/ledger').includes('ordinary input'));
});

test('one main turn consumes a batch of task notifications without leaving phantom pending input', async () => {
  const f = fixture(); await f.start();
  for (let i = 0; i < 2; i++)
    await f.event('prompt.submit', { text: `task notification ${i}`, origin: { kind: 'task-notification' } });
  await f.event('turn.start', { text: 'batched task notifications', turnId: 'notifications' });
  await f.step('notifications');
  await f.event('turn.complete', { turnId: 'notifications', isAborted: false, reason: 'answer' });
  assert.equal(f.ledger().pendingInputs, 0);
  assert.deepEqual(f.ledger().activeTurns, []);
  assert.equal(f.ledger().ordinaryRevision, f.ledger().revision);
  f.request();
  assert.equal((await f.event('classic.PreCompact', { trigger: 'manual' })).block, undefined);
});

test('child and compact turns cannot consume input waiting for the next main turn', async () => {
  const f = fixture(); await f.start(); await f.ordinary();
  await f.event('prompt.submit', { text: 'new user input', origin: { kind: 'sdk' } });
  await f.event('turn.start', { text: 'child work', turnId: 'child', agentId: 'child-1' });
  assert.equal(f.ledger().pendingInputs, 1);
  await f.event('turn.complete', { turnId: 'child', agentId: 'child-1', reason: 'answer' });
  await f.event('turn.start', { text: '/compact', turnId: 'compact' });
  assert.equal(f.ledger().pendingInputs, 1);
  await f.event('turn.complete', { turnId: 'compact', reason: 'answer' });
  f.request();
  assert((await f.event('classic.PreCompact', { trigger: 'manual' })).block);
  await f.event('turn.start', { text: 'new user input', turnId: 'main-2' });
  assert.equal(f.ledger().pendingInputs, 0);
  await f.event('prompt.submit', { text: 'input arriving after the batch started' });
  await f.step('main-2');
  await f.event('turn.complete', { turnId: 'main-2', isAborted: false, reason: 'answer' });
  assert.equal(f.ledger().pendingInputs, 1);
});

test('notifications and peer reports delivered into the active main turn are not queued input', async () => {
  for (const kind of ['task-notification', 'peer', 'peer-send-message']) {
    const f = fixture(); await f.start();
    await f.event('prompt.submit', { text: 'initial input', origin: { kind: 'sdk' } });
    await f.event('turn.start', { text: 'initial input', turnId: 'main' });
    await f.step('main');
    const revision = f.ledger().revision;
    await f.event('prompt.submit', { text: 'completed work report', origin: { kind }, turnId: 'main', wait: false });
    assert.equal(f.ledger().pendingInputs, 0, `${kind} is already delivered to this turn`);
    assert.equal(f.ledger().revision, revision + 1);
    assert.equal(f.ledger().cacheRequest, null, 'delivered reports still invalidate prior cache evidence');
    await f.step('main');
    await f.event('turn.complete', { turnId: 'main', reason: 'answer', isAborted: false });
    assert.equal(f.ledger().pendingInputs, 0);
    assert.deepEqual(f.ledger().activeTurns, []);
    assert.equal(f.ledger().ordinaryRevision, f.ledger().revision);
    f.request();
    assert.equal((await f.event('classic.PreCompact', { trigger: 'manual' })).block, undefined);
  }
});

test('delivered reports do not consume a real user prompt queued over the same main turn', async () => {
  for (const wait of [false, true]) {
    const f = fixture(); await f.start();
    await f.event('turn.start', { text: 'initial input', turnId: 'main' });
    await f.event('prompt.submit', { text: 'next user request', origin: { kind: 'sdk' }, turnId: 'main', wait });
    await f.event('prompt.submit', { text: 'completed work report', origin: { kind: 'peer' }, turnId: 'main', wait: false });
    assert.equal(f.ledger().pendingInputs, 1, 'only the user request is still queued');
    await f.step('main');
    await f.event('turn.complete', { turnId: 'main', reason: 'answer', isAborted: false });
    assert.equal(f.ledger().pendingInputs, 1);
    f.request();
    assert((await f.event('classic.PreCompact', { trigger: 'manual' })).block);
    await f.event('turn.start', { text: 'next user request', turnId: 'next-main' });
    assert.equal(f.ledger().pendingInputs, 0);
  }
});

test('unbound, foreign, waiting and unknown-origin submissions remain pending until a main turn starts', async () => {
  for (const delivery of [
    { origin: { kind: 'peer' } },
    { origin: { kind: 'peer' }, turnId: 'other', wait: false },
    { origin: { kind: 'peer' }, turnId: 'main', wait: true },
    { origin: { kind: 'unclassified' }, turnId: 'main', wait: false },
    { origin: { kind: 'plugin', name: 'synthetic' }, turnId: 'main', wait: false },
  ]) {
    const f = fixture(); await f.start();
    await f.event('turn.start', { text: 'initial input', turnId: 'main' });
    await f.event('prompt.submit', { text: 'queued input', ...delivery });
    await f.step('main');
    await f.event('turn.complete', { turnId: 'main', reason: 'answer', isAborted: false });
    assert.equal(f.ledger().pendingInputs, 1);
  }
});

test('a child or finished main turn cannot accept reports on behalf of the active main turn', async () => {
  const f = fixture(); await f.start();
  await f.event('turn.start', { text: 'initial input', turnId: 'main' });
  await f.event('turn.start', { text: 'child input', turnId: 'child', agentId: 'agent' });
  await f.event('prompt.submit', { text: 'child report', origin: { kind: 'peer' }, turnId: 'child', wait: false });
  assert.equal(f.ledger().pendingInputs, 1);
  await f.event('turn.complete', { turnId: 'child', agentId: 'agent', reason: 'answer' });
  await f.step('main');
  await f.event('turn.complete', { turnId: 'main', reason: 'answer', isAborted: false });
  await f.event('prompt.submit', { text: 'late report', origin: { kind: 'peer' }, turnId: 'main', wait: false });
  assert.equal(f.ledger().pendingInputs, 2);
});

test('aborted or failed turns cannot discard queued input or publish cache evidence after a delivered report', async () => {
  for (const reason of ['aborted', 'error']) {
    const f = fixture(); await f.start();
    await f.event('turn.start', { text: 'initial input', turnId: 'main' });
    await f.event('prompt.submit', { text: 'completed work report', origin: { kind: 'peer' }, turnId: 'main', wait: false });
    await f.event('prompt.submit', { text: 'next user request', origin: { kind: 'sdk' }, turnId: 'main', wait: true });
    await f.step('main');
    await f.event('turn.complete', { turnId: 'main', reason, isAborted: reason === 'aborted' });
    assert.equal(f.ledger().pendingInputs, 1);
    assert.equal(f.ledger().cacheRequest, null);
    assert.equal(f.ledger().ordinaryEndedAt, null);
  }
});

test('observer records effective TTL policy with force/env/settings precedence and no invented usage fields', async () => {
  for (const [env, settings, expected] of [
    [{}, {}, { ttl: null, source: 'default' }],
    [{}, { promptCacheTtl: '1h' }, { ttl: '1h', source: 'settings' }],
    [{ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, { promptCacheTtl: '5m' }, { ttl: '1h', source: 'environment' }],
    [{ FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, {}, { ttl: '5m', source: 'environment' }],
    [{ FORCE_PROMPT_CACHING_5M: '0', ENABLE_PROMPT_CACHING_1H: '1' }, {}, { ttl: '1h', source: 'environment' }],
  ]) {
    const f = fixture(env, settings); await f.start(); await f.ordinary();
    assert.deepEqual(f.ledger().cacheRequest.policy, expected);
    assert.equal(f.ledger().cacheRequest.startedAt, 1_000_000);
    assert.equal(f.ledger().cacheDeadline, undefined);
    await f.event('classic.Stop', { transcript_path: '/actual-session.jsonl' });
    assert.equal(f.ledger().transcriptPath, '/actual-session.jsonl');
  }
});

test('native guard blocks expired, cancelled, changed-session and new-activity reservations', async () => {
  for (const override of [{ expiresAt: 0 }, { status: 'cancelled' }, { generation: 'old' }, { revision: 0 }]) {
    const f = fixture(); await f.start(); await f.ordinary(); f.request(override);
    const result = await f.event('classic.PreCompact', { trigger: 'manual' });
    assert(result.block);
    assert.equal(f.ledger().compact.status, 'failed');
  }
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.event('prompt.submit', { text: 'new user input' });
  assert((await f.event('classic.PreCompact', { trigger: 'manual' })).block);
});

test('only native PostCompact completes an operation; overlapping user work makes its result unknown', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.event('classic.PreCompact', { trigger: 'manual' });
  assert.equal(f.ledger().compact.status, 'running');
  await f.event('prompt.submit', { text: 'new work' });
  await f.event('classic.PostCompact', { trigger: 'manual' });
  assert.equal(f.ledger().compact.status, 'unknown');
  const clean = fixture(); await clean.start(); await clean.ordinary(); clean.request();
  await clean.event('classic.PreCompact', { trigger: 'manual' });
  await clean.event('classic.PostCompact', { trigger: 'manual' });
  assert.equal(clean.ledger().compact.status, 'completed');
});

test('unrequested compaction cannot produce a requested receipt, and subagent work remains busy', async () => {
  const f = fixture(); await f.start(); await f.ordinary();
  await f.event('classic.PreCompact', { trigger: 'manual' });
  await f.event('classic.PostCompact', { trigger: 'manual' });
  assert.equal(f.ledger().compact.id, null);
  await f.event('turn.start', { text: 'child', turnId: 'child-1', agentId: 'child' });
  assert.deepEqual(f.ledger().activeTurns, ['child-1']);
  await f.event('turn.complete', { turnId: 'child-1', agentId: 'child' });
  assert.deepEqual(f.ledger().activeTurns, []);
});

test('delayed heartbeat preserves the request clock; backwards clocks and session end invalidate it', async () => {
  const delayed = fixture(); await delayed.start(); await delayed.ordinary();
  delayed.advance(30_000); await delayed.event('turn.complete', { turnId: 'child', agentId: 'child' });
  assert.equal(delayed.ledger().cacheRequest.startedAt, 1_000_000);
  const backwards = fixture(); await backwards.start(); await backwards.ordinary();
  backwards.advance(-1); await backwards.event('turn.complete', { turnId: 'child', agentId: 'child' });
  assert.equal(backwards.ledger().cacheRequest, null);
  await delayed.event('session.end');
  assert.equal(delayed.ledger().closed, true);
  assert.equal(delayed.ledger().cacheRequest, null);
});

test('a no-op compact or local slash command cannot leave the observer permanently busy', async () => {
  const f = fixture(); await f.start(); await f.ordinary();
  await f.event('classic.PreCompact', { trigger: 'manual' });
  await f.event('command.run', { command: 'compact' });
  assert.equal(f.ledger().compact.status, 'failed');
  await f.event('prompt.submit', { text: '/help' });
  assert.equal(f.ledger().pendingInputs, 0);
});

test('a model switch invalidates an old reservation without reusing the previous model cache clock', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.event('classic.PostModelSwitch', { to_model: 'another-model' });
  assert.equal(f.ledger().ordinaryRevision, null);
  assert.equal(f.ledger().cacheRequest, null);
  assert((await f.event('classic.PreCompact', { trigger: 'manual' })).block);
});
