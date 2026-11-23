import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerObserver } from '../server/observer-source.mjs';

function fixture(env = {}, settings = {}) {
  let time = 1_000_000, contextTokens = 100_000, usageGate = null, afterUsage = null, clockGate = null, usageFailures = 0;
  const hooks = new Map(), files = new Map();
  const timers = new Set();
  const configuration = { launchId: 'launch-1', ledger: '/ledger', request: '/request', receipts: '/receipts' };
  // A held clock read blocks only the first read after a context reading.
  const $ = { clock: { now: async () => { if (clockGate) { const gate = clockGate; clockGate = null; await gate(); } return time; }, every: (_ms, fn) => {
      const timer = { fn, cancel() { timers.delete(timer); } };
      timer.ms = _ms; timers.add(timer); return timer;
    } },
    fs: { write: async (p, v) => files.set(p, v), read: async p => files.get(p) ?? '{}' },
    session: { id: async () => 'native-1',
      // A held reading resolves to the context as it is when released.
      usage: async () => { await usageGate;
        if (usageFailures > 0) { usageFailures--; throw new Error('usage unavailable'); } if (afterUsage) { clockGate = afterUsage; afterUsage = null; }
        return { context: { window: 1_000_000, ...(contextTokens === undefined ? {} : { tokens: contextTokens }) } }; } },
    env: { get: async name => env[name] },
    settings: { read: async () => settings } };
  registerObserver((name, ...rest) => { hooks.set(name, rest.at(-1)); return { catch() {} }; }, configuration);
  const event = (name, input = {}, next = async () => ({})) => hooks.get(name)($, input, next);
  // Runs the timers due after `ms` (only those with interval `only`, if given), then lets
  // readings they started settle, as the next event-loop turn would.
  const tick = async (ms = 500, only) => {
    time += ms;
    for (const timer of [...timers]) if (only === undefined || timer.ms === only) await timer.fn();
    await new Promise(resolve => setImmediate(resolve));
  };
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
    while (!(await generator.next()).done) { /* drain the step */ }
  };
  // Paseo's /compact runs as a command around Claude's compaction and hooks.
  const compact = (inner = async () => {}) => event('command.run', { command: 'compact', args: '' },
    async () => { await inner(); return {}; });
  return { event, step, ledger, request, files, compact, tick,
    timers: () => timers.size,
    intervals: () => [...timers].map(timer => timer.ms),
    failUsage(count = 1) { usageFailures = count; },
    advance(ms) { time += ms; },
    context(tokens) { contextTokens = tokens; },
    holdNextClock() {
      let release, reached;
      const held = new Promise(resolve => { release = resolve; });
      const arrival = new Promise(resolve => { reached = resolve; });
      clockGate = () => { reached(); return held; };
      return { release, reached: arrival };
    },
    holdClockAfterUsage() {
      let release, reached;
      const held = new Promise(resolve => { release = resolve; });
      const arrival = new Promise(resolve => { reached = resolve; });
      afterUsage = () => { reached(); return held; };
      return { release, reached: arrival };
    },
    holdUsage() { let release; usageGate = new Promise(resolve => { release = () => { usageGate = null; resolve(); }; }); return release; },
    async start() { await event('session.start'); },
    async ordinary(reported = usage, responseDelay = 0) {
      await event('prompt.submit', { text: 'ordinary input' });
      await event('turn.start', { text: 'ordinary input', turnId: 'user-1' });
      const generator = hooks.get('turn.step')($, { turnId: 'user-1' }, async function* () {
        for (let elapsed = 0; elapsed < responseDelay; elapsed += 5000) {
          await tick(Math.min(5000, responseDelay - elapsed));
        }
        return { usage: reported };
      });
      while (!(await generator.next()).done) { /* drain the step */ }
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

test('a user prompt absorbed into a later step of the active main turn is no longer queued', async () => {
  const f = fixture(); await f.start();
  await f.event('prompt.submit', { text: 'initial input', origin: { kind: 'sdk' } });
  await f.event('turn.start', { text: 'initial input', turnId: 'main' });
  await f.step('main');
  await f.event('prompt.submit', {
    text: 'follow-up handled by this turn', origin: { kind: 'sdk' }, turnId: 'main', wait: true,
  });
  assert.equal(f.ledger().pendingInputs, 1);
  await f.step('main');
  await f.event('turn.complete', { turnId: 'main', reason: 'answer', isAborted: false });
  assert.equal(f.ledger().pendingInputs, 0);
  assert.deepEqual(f.ledger().activeTurns, []);
  f.request();
  assert.equal((await f.event('classic.PreCompact', { trigger: 'manual' })).block, undefined);
});

test('a later main step absorbs SDK user input while delivered reports do not change its count', async () => {
  for (const wait of [false, true]) {
    const f = fixture(); await f.start();
    await f.event('turn.start', { text: 'initial input', turnId: 'main' });
    await f.event('prompt.submit', { text: 'next user request', origin: { kind: 'sdk' }, turnId: 'main', wait });
    await f.event('prompt.submit', { text: 'completed work report', origin: { kind: 'peer' }, turnId: 'main', wait: false });
    assert.equal(f.ledger().pendingInputs, 1, 'only the user request is still queued');
    await f.step('main');
    assert.equal(f.ledger().pendingInputs, 1, 'absorption is committed only by successful completion');
    await f.event('turn.complete', { turnId: 'main', reason: 'answer', isAborted: false });
    assert.equal(f.ledger().pendingInputs, 0);
    f.request();
    assert.equal((await f.event('classic.PreCompact', { trigger: 'manual' })).block, undefined);
  }
});

test('SDK input submitted after the final main step remains queued for the next turn', async () => {
  const f = fixture(); await f.start();
  await f.event('turn.start', { text: 'initial input', turnId: 'main' });
  await f.step('main');
  await f.event('prompt.submit', {
    text: 'next user request', origin: { kind: 'sdk' }, turnId: 'main', wait: true,
  });
  await f.event('turn.complete', { turnId: 'main', reason: 'answer', isAborted: false });
  assert.equal(f.ledger().pendingInputs, 1);
  f.request();
  assert((await f.event('classic.PreCompact', { trigger: 'manual' })).block);
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
  backwards.advance(-10_001); await backwards.event('turn.complete', { turnId: 'child', agentId: 'child' });
  assert.equal(backwards.ledger().cacheRequest, null);
  await delayed.event('session.end');
  assert.equal(delayed.ledger().closed, true);
  assert.equal(delayed.ledger().cacheRequest, null);
});

// WSL2 steps its wall clock back by a second or two (observed: -1.8 s) when
// the host corrects drift. Those steps are not a rollback of the request.
test('a WSL clock step back keeps the cache clock; a step beyond the tolerance still invalidates it', async () => {
  const stepped = fixture(); await stepped.start(); await stepped.ordinary();
  const before = stepped.ledger();
  stepped.advance(-1_800); await stepped.event('turn.complete', { turnId: 'child', agentId: 'child' });
  assert.deepEqual(stepped.ledger().cacheRequest, before.cacheRequest);
  assert.equal(stepped.ledger().ordinaryEndedAt, before.ordinaryEndedAt);
  assert.equal(stepped.ledger().clockEpoch, before.clockEpoch);
  stepped.advance(-10_000); await stepped.event('turn.complete', { turnId: 'child', agentId: 'child' });
  assert.equal(stepped.ledger().clockEpoch, before.clockEpoch, 'tolerance applies to each step from the last save');
  const rolled = fixture(); await rolled.start(); await rolled.ordinary();
  const epoch = rolled.ledger().clockEpoch;
  rolled.advance(-10_001); await rolled.event('turn.complete', { turnId: 'child', agentId: 'child' });
  assert.equal(rolled.ledger().clockEpoch, epoch + 1);
});

test('Compact now admits a request prepared just before a WSL clock step back', async () => {
  // Reproduces e6ee93ba: Paseo prepared at 04.414, then Claude read 03.491.
  for (const run of [cmd => cmd.compact(async () => {}), cmd => cmd.event('classic.PreCompact', { trigger: 'manual' })]) {
    const f = fixture(); await f.start(); await f.ordinary();
    f.request({ requireCache: false, preparedAt: 1_000_000 + 1_800 });
    const result = await run(f);
    assert.equal(result.text, undefined);
    assert.equal(result.block, undefined);
    assert.equal(f.ledger().compact.status, 'running');
  }
  const automatic = fixture(); await automatic.start(); await automatic.ordinary();
  automatic.request({ preparedAt: 1_000_000 + 10_000 });
  assert.equal((await automatic.event('classic.PreCompact', { trigger: 'manual' })).block, undefined);
  assert.equal(automatic.ledger().compact.status, 'running');
});

test('a request prepared beyond the clock-step tolerance is still refused as expired', async () => {
  const f = fixture(); await f.start(); await f.ordinary();
  f.request({ requireCache: false, preparedAt: 1_000_000 + 10_001 });
  const result = await f.compact(async () => { throw new Error('must not compact'); });
  assert.match(result.text, /Reservation expired/);
  assert.equal(f.ledger().compact.reason, 'Reservation expired');
});

test('a no-op compact or local slash command cannot leave the observer permanently busy', async () => {
  const f = fixture(); await f.start(); await f.ordinary();
  await f.compact(() => f.event('classic.PreCompact', { trigger: 'manual' }));
  assert.equal(f.ledger().compact.status, 'failed');
  await f.event('prompt.submit', { text: '/help' });
  assert.equal(f.ledger().pendingInputs, 0);
});

test('the /compact command guards a reservation even when policy plugins skip PreCompact', async () => {
  for (const override of [{ expiresAt: 0 }, { status: 'cancelled' }, { generation: 'old' }, { revision: 0 }]) {
    const f = fixture(); await f.start(); await f.ordinary(); f.request(override);
    let ran = false;
    const result = await f.compact(async () => { ran = true; });
    assert(result.text, 'the command answers with the refusal instead of compacting');
    assert.equal(ran, false);
    assert.equal(f.ledger().compact.status, 'failed');
  }
});

test('with classic hooks delivered, the command keeps one guard and PostCompact completes it', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact(async () => {
    assert.equal((await f.event('classic.PreCompact', { trigger: 'manual' })).block, undefined);
    assert.equal(f.ledger().compact.status, 'running');
    await f.event('classic.PostCompact', { trigger: 'manual' });
  });
  assert.deepEqual(f.ledger().compact, { id: 'operation-1', status: 'completed', revision: 1, reason: null });
});

test('with classic hooks skipped by an organization policy, a reset context window completes the receipt', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact();
  assert.equal(f.ledger().compact.status, 'running', 'a returning command alone is not completion');
  await f.tick();
  assert.equal(f.ledger().compact.status, 'running');
  f.context(undefined);
  await f.tick();
  assert.deepEqual(f.ledger().compact, { id: 'operation-1', status: 'completed', revision: 1, reason: null });
});

test('with classic hooks skipped, an unchanged context window fails', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact();
  for (let i = 0; i < 19; i++) await f.tick();
  assert.equal(f.ledger().compact.status, 'running');
  await f.tick();
  assert.equal(f.ledger().compact.status, 'failed');
  assert.equal(f.ledger().compact.reason, 'Claude returned without completing compaction');
});

// Paseo 0.16.2 and later deliver input steered into a compaction right after
// the command returns. Submitting it does not refill the context; the next
// model response does.
test('with classic hooks skipped, a context already reset when the command returns completes despite steered input', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact(async () => f.context(undefined));
  // The steered input is answered before the first 500 ms poll.
  await f.event('prompt.submit', { text: 'steered input', origin: { kind: 'sdk' } });
  await f.event('turn.start', { text: 'steered input', turnId: 'user-2' });
  await f.step('user-2');
  await f.tick();
  const { id, status, reason } = f.ledger().compact;
  assert.deepEqual({ id, status, reason }, { id: 'operation-1', status: 'completed', reason: null });
  assert.equal(JSON.parse(f.files.get('/receipts/operation-1.json')).status, 'completed');
});

test('with classic hooks skipped, input submitted after the command does not stop a later reset from counting', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact();
  await f.event('prompt.submit', { text: 'steered input', origin: { kind: 'sdk' } });
  assert.equal(f.ledger().compact.status, 'running');
  f.context(undefined);
  await f.tick();
  assert.equal(f.ledger().compact.status, 'completed');
});

test('with classic hooks skipped, a later model request before any reset leaves completion unknown', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact();
  await f.event('prompt.submit', { text: 'steered input', origin: { kind: 'sdk' } });
  await f.event('turn.start', { text: 'steered input', turnId: 'user-2' });
  await f.step('user-2');
  // A refill cannot be told apart from a compaction that did nothing.
  assert.equal(f.ledger().compact.status, 'unknown');
  f.context(undefined);
  for (let i = 0; i < 21; i++) await f.tick();
  assert.equal(f.ledger().compact.status, 'unknown');
});

test('with classic hooks skipped, a reading that ends after the operation was superseded records nothing', async () => {
  for (const [name, supersede] of [
    ['session end', f => f.event('session.end')],
    ['model switch', f => f.event('classic.PostModelSwitch', { to_model: 'another-model' })],
    ['later model request', async f => {
      await f.event('turn.start', { text: 'steered input', turnId: 'user-2' });
      await f.step('user-2');
    }],
  ]) {
    const f = fixture(); await f.start(); await f.ordinary(); f.request();
    await f.compact();
    const release = f.holdUsage();
    const reading = f.tick();
    await supersede(f);
    f.context(undefined);
    release();
    await reading;
    assert.equal(f.ledger().compact.status, 'unknown', name);
  }
});

test('with classic hooks skipped, a reading in flight never rewrites a result already recorded', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact();
  for (let i = 0; i < 19; i++) await f.tick();
  assert.equal(f.ledger().compact.status, 'running');
  await f.event('turn.start', { text: 'steered input', turnId: 'user-2' });
  // The last reading of the 10-second window is held right after it reads the context,
  // while the steered input's model request starts and records its own result.
  const { release, reached } = f.holdClockAfterUsage();
  const reading = f.tick();
  await reached;
  await f.step('user-2');
  const recorded = f.ledger().compact.status;
  assert.notEqual(recorded, 'running');
  release();
  await reading;
  assert.equal(f.ledger().compact.status, recorded, 'a terminal result is never rewritten');
});

test('with classic hooks skipped, a reading that ends after the operation was replaced records nothing for it', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact();
  const release = f.holdUsage();
  const reading = f.tick();
  // Claude's own automatic compaction takes the observer's current operation.
  await f.event('classic.PreCompact', { trigger: 'auto' });
  f.context(undefined);
  release();
  await reading;
  assert.equal(f.files.get('/receipts/operation-1.json'), undefined, 'no receipt for the replaced operation');
  assert.deepEqual({ id: f.ledger().compact.id, status: f.ledger().compact.status }, { id: null, status: 'running' });
});

test('with classic hooks skipped, the window is read every 500 ms after the command returns', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact();
  assert.deepEqual(f.intervals().sort((a, b) => a - b), [500, 5_000], 'confirmation reads and the heartbeat');
});

test('with classic hooks skipped, a context reading that fails is retried, and the 10-second limit still applies', async () => {
  // The first reading, as the command returns, fails; a later one sees the reset.
  const g = fixture(); await g.start(); await g.ordinary(); g.request();
  await g.compact(async () => { g.context(undefined); g.failUsage(1); });
  assert.equal(g.ledger().compact.status, 'running');
  await g.tick();
  assert.equal(g.ledger().compact.status, 'completed');
  // Readings that keep failing end as a failure at the limit, not a stuck operation.
  const h = fixture(); await h.start(); await h.ordinary(); h.request();
  await h.compact(async () => h.failUsage(1_000));
  for (let i = 0; i < 19; i++) await h.tick();
  assert.equal(h.ledger().compact.status, 'running');
  await h.tick();
  assert.equal(h.ledger().compact.status, 'failed');
});

test('with classic hooks skipped, a context reading that never settles holds neither the command nor the 10-second limit', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  let release;
  const returned = f.compact(async () => { release = f.holdUsage(); });
  await returned; // the command returns while the reading stays pending
  for (let i = 0; i < 19; i++) void f.tick(); // each tick's reading stays pending
  assert.equal(f.ledger().compact.status, 'running');
  void f.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ledger().compact.status, 'failed', 'no reset seen within 10 seconds');
  f.context(undefined);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ledger().compact.status, 'failed', 'a late reading cannot change it');
});

test('with classic hooks skipped, a reading still pending at the 10-second limit does not defer the failure', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact();
  for (let i = 0; i < 18; i++) await f.tick(500, 500);
  // The reading the 9.5-second tick starts is still pending when the limit passes.
  const release = f.holdUsage();
  await f.tick(500, 500);
  assert.equal(f.ledger().compact.status, 'running');
  await f.tick(500, 500);
  assert.equal(f.ledger().compact.status, 'failed');
  // A model request after the limit does not turn the failure into unknown.
  await f.event('turn.start', { text: 'steered input', turnId: 'user-2' });
  release();
  await f.step('user-2');
  assert.equal(f.ledger().compact.status, 'failed');
});

test('with classic hooks skipped, a model request while the limit reads the clock keeps unknown', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact();
  for (let i = 0; i < 19; i++) await f.tick(500, 500);
  await f.event('turn.start', { text: 'steered input', turnId: 'user-2' });
  // The confirmation's tick at the 10-second limit waits on the clock while a model request starts.
  const { release, reached } = f.holdNextClock();
  const limit = f.tick(500, 500);
  await reached;
  const stepping = f.step('user-2');
  await new Promise(resolve => setImmediate(resolve));
  release();
  await limit; await stepping;
  assert.equal(f.ledger().compact.status, 'unknown', 'the limit never rewrites a recorded result');
});

test('without a context reading before /compact, completion stays unknown rather than guessed', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  f.context(undefined);
  await f.compact();
  assert.equal(f.ledger().compact.status, 'unknown');
});

test('a model switch invalidates an old reservation without reusing the previous model cache clock', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.event('classic.PostModelSwitch', { to_model: 'another-model' });
  assert.equal(f.ledger().ordinaryRevision, null);
  assert.equal(f.ledger().cacheRequest, null);
  assert((await f.event('classic.PreCompact', { trigger: 'manual' })).block);
});

test('a cancelled reservation blocks one late /compact, then the user can compact manually', async () => {
  const f = fixture(); await f.start(); await f.ordinary();
  f.files.set('/request', JSON.stringify({ id: 'operation-1', status: 'cancelled' }));
  f.advance(3 * 3_600_000);
  await f.ordinary();
  let ran = false;
  const late = await f.compact(async () => { ran = true; });
  assert.match(late.text, /Run \/compact again/);
  assert.equal(ran, false);
  assert.deepEqual(f.ledger().compact, { id: 'operation-1', status: 'failed', revision: 2,
    reason: 'Reservation cancelled' });
  await f.compact(async () => { ran = true; });
  assert.equal(ran, true, 'the user\'s own /compact is no longer blocked');
  assert.equal(f.ledger().compact.id, null);
  const classic = fixture(); await classic.start(); await classic.ordinary();
  classic.files.set('/request', JSON.stringify({ id: 'operation-1', status: 'cancelled' }));
  assert((await classic.event('classic.PreCompact', { trigger: 'manual' })).block);
  assert.equal((await classic.event('classic.PreCompact', { trigger: 'manual' })).block, undefined);
});

test('a repeated session start keeps a single heartbeat', async () => {
  const f = fixture(); await f.start(); await f.start();
  assert.equal(f.timers(), 1);
});


test('operation receipts survive later ordinary activity and session closure', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact(async () => {
    await f.event('classic.PreCompact', { trigger: 'manual' });
    await f.event('classic.PostCompact');
  });
  const completed = JSON.parse(f.files.get('/receipts/operation-1.json'));
  assert.equal(completed.status, 'completed');
  assert.equal(completed.sessionId, 'native-1');
  await f.ordinary(); await f.event('session.end');
  const retained = JSON.parse(f.files.get('/receipts/operation-1.json'));
  assert.equal(retained.status, 'completed');
  assert.equal(retained.revision, completed.revision);
  assert.equal(retained.generation, completed.generation);
});

test('heartbeat and session closure do not recreate a successfully written expired receipt', async () => {
  const f = fixture(); await f.start(); await f.ordinary(); f.request();
  await f.compact(async () => {
    await f.event('classic.PreCompact', { trigger: 'manual' });
    await f.event('classic.PostCompact');
  });
  assert(f.files.has('/receipts/operation-1.json'));
  f.files.delete('/receipts/operation-1.json');
  await f.tick(7 * 24 * 60 * 60_000); await f.ordinary(); await f.event('session.end');
  assert.equal(f.files.has('/receipts/operation-1.json'), false);
  assert.equal(f.ledger().closed, true);
});

test('a new generation in the same launch and session records an attributable query-restart refusal', async () => {
  for (const mode of ['command', 'precompact']) {
    const f = fixture(); await f.start();
    const prepared = { launchId: 'launch-1', generation: 'prior-generation', sessionId: 'native-1', revision: 3 };
    f.request(prepared);
    let ran = false;
    const outcome = mode === 'command'
      ? await f.compact(async () => { ran = true; })
      : await f.event('classic.PreCompact', { trigger: 'manual' }, async () => { ran = true; return {}; });
    assert.equal(ran, false, `${mode}: compaction must be blocked`);
    assert.match(mode === 'command' ? outcome.text : outcome.block, /query restarted/i, mode);
    const compact = f.ledger().compact;
    assert.equal(compact.id, 'operation-1', mode);
    assert.equal(compact.status, 'failed', mode);
    assert.equal(compact.refusal, 'query_restarted', mode);
    assert.deepEqual(compact.prepared, prepared, mode);
    assert.match(compact.reason, /query restarted/i, mode);
    const receipt = JSON.parse(f.files.get('/receipts/operation-1.json'));
    assert.equal(receipt.id, 'operation-1', mode);
    assert.equal(receipt.launchId, 'launch-1', mode);
    assert.notEqual(receipt.generation, prepared.generation, mode);
    assert.equal(receipt.sessionId, 'native-1', mode);
    assert.equal(receipt.status, 'failed', mode);
    assert.equal(receipt.refusal, 'query_restarted', mode);
    assert.deepEqual(receipt.prepared, prepared, mode);
    // A subsequent manual /compact in the new generation runs unblocked and preserves the refusal receipt.
    await f.compact(async () => { ran = true; });
    assert.equal(ran, true, `${mode}: later manual compact is not blocked`);
    assert.equal(f.ledger().compact.id, null, mode);
    assert.deepEqual(JSON.parse(f.files.get('/receipts/operation-1.json')), receipt, mode);
  }
});

test('different launch, different session or generic cancellation never records a query-restart refusal', async () => {
  for (const [name, overrides] of [
    ['different launch', { launchId: 'other-launch', generation: 'prior-generation' }],
    ['different session', { sessionId: 'other-session', generation: 'prior-generation' }],
    ['generic cancellation', { status: 'cancelled', generation: 'prior-generation' }],
  ]) {
    const f = fixture(); await f.start();
    if (overrides.status === 'cancelled')
      f.files.set('/request', JSON.stringify({ id: 'operation-1', status: 'cancelled' }));
    else
      f.request(overrides);
    const outcome = await f.compact(async () => { throw new Error('must not compact'); });
    assert(outcome.text, name);
    const receipt = JSON.parse(f.files.get('/receipts/operation-1.json'));
    assert.equal(receipt.status, 'failed', name);
    assert.equal(receipt.refusal, undefined, name);
    assert.equal(receipt.prepared, undefined, name);
  }
});
