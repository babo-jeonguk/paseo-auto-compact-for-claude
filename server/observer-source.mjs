// Runs inside Claude's Mod sandbox. No stdio interception, sockets or model calls.
// Only identifiers, activity and reported usage are persisted, never message text.
let state;
let configuration;
let writes = Promise.resolve();
async function save($) {
  const now = await $.clock.now();
  if (state.updatedAt && now < state.updatedAt) {
    state.cacheRequest = null;
    state.ordinaryEndedAt = null;
    state.clockEpoch++;
  }
  state.updatedAt = now;
  const snapshot = JSON.stringify(state);
  writes = writes.catch(() => {}).then(() => $.fs.write(configuration.ledger, snapshot));
  await writes;
}

async function cachePolicy($) {
  try {
    if (await $.env.get('FORCE_PROMPT_CACHING_5M') === '1') return { ttl: '5m', source: 'environment' };
    const named = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL');
    if (named === '5m' || named === '1h') return { ttl: named, source: 'environment' };
    const settings = await $.settings.read();
    if (settings.promptCacheTtl === '5m' || settings.promptCacheTtl === '1h')
      return { ttl: settings.promptCacheTtl, source: 'settings' };
    if (await $.env.get('ENABLE_PROMPT_CACHING_1H') === '1') return { ttl: '1h', source: 'environment' };
  } catch {}
  return { ttl: null, source: 'default' };
}

async function admit($, trigger) {
  let request;
  try { request = JSON.parse(await $.fs.read(configuration.request)); } catch {}
  const now = await $.clock.now();
  // Unrequested/manual/CLI compaction is observed but cannot complete an
  // automatic operation. The host also pins the public send's message/turn id.
  if (request?.status === 'cancelled' && request.id && trigger !== 'auto') {
    state.compact = { id: request.id, status: 'failed', revision: state.revision, reason: 'Reservation cancelled' };
    await save($);
    return 'Reservation cancelled';
  }
  let reason = null;
  if (!request || request.status !== 'prepared' || trigger === 'auto' || state.compact?.id === request.id)
    state.compact = { id: null, status: 'running', revision: state.revision };
  else {
    if (request.launchId !== state.launchId || request.generation !== state.generation ||
        request.sessionId !== state.sessionId) reason = 'Claude session changed';
    else if (request.revision !== state.revision || state.activeTurns.length || state.pendingInputs)
      reason = 'New conversation activity';
    else if (now > request.expiresAt || now < request.preparedAt) reason = 'Reservation expired';
    else if (request.requireCache && (request.clockEpoch !== state.clockEpoch ||
        !Number.isFinite(request.cacheDeadline) || now >= request.cacheDeadline - 30_000))
      reason = 'Cache window passed';
    state.compact = { id: request.id, status: reason ? 'failed' : 'running',
      revision: state.revision, reason };
  }
  state.cacheRequest = null;
  state.ordinaryEndedAt = null;
  state.ordinaryRevision = null;
  await save($);
  return reason;
}

// The live window reports no fill from just after a compaction until the
// next response; a cancelled or no-op /compact leaves the old fill in place.
async function confirm($, operation) {
  const deadline = await $.clock.now() + 10_000;
  const timer = await $.clock.every(500, async () => {
    if (state.compact !== operation || operation.status !== 'running') return timer.cancel();
    const reset = (await $.session.usage()).context.tokens === undefined;
    if (!reset && await $.clock.now() < deadline) return;
    timer.cancel();
    operation.status = reset ? 'completed' : 'failed';
    if (!reset) operation.reason = 'Claude returned without completing compaction';
    await save($);
  });
}

export function registerObserver(on, config) {
  configuration = config;
  writes = Promise.resolve();
  state = {
    version: 1, launchId: configuration.launchId, generation: crypto.randomUUID(),
    sessionId: null, updatedAt: 0, revision: 0, activeTurns: [], pendingInputs: 0,
    ordinaryEndedAt: null, ordinaryRevision: null, cacheRequest: null, transcriptPath: null,
    compact: null, closed: false, clockEpoch: 0,
  };
  let heartbeat;
  let requestStartedAt = null;
  let ordinaryTurnId = null;
  const supersede = () => {
    if (state.compact?.status === 'running') state.compact.status = 'unknown';
  };
  on('session.start', async ($, e, next) => {
    state.sessionId = await $.session.id();
    await save($);
    heartbeat = await $.clock.every(5_000, async () => save($));
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    state.closed = true;
    state.cacheRequest = null;
    supersede();
    heartbeat?.cancel();
    await save($);
    return next(e);
  });
  on('prompt.submit', async ($, e, next) => {
    if (!/^\/compact(?:\s|$)/.test(e.text.trim())) {
      state.revision++;
      // These engine deliveries already enter the running main turn. A user's
      // prompt can carry the same turnId while still waiting for its next turn.
      const delivered = ordinaryTurnId !== null && e.turnId === ordinaryTurnId &&
        state.activeTurns.includes(e.turnId) && e.wait !== true &&
        ['task-notification', 'peer', 'peer-send-message'].includes(e.origin?.kind);
      if (!e.text.trim().startsWith('/') && !delivered) state.pendingInputs++;
      state.cacheRequest = null;
      state.ordinaryEndedAt = null;
      state.ordinaryRevision = null;
      supersede();
      await save($);
    }
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !/^\/compact(?:\s|$)/.test(e.text.trim())) {
      ordinaryTurnId = e.turnId;
      requestStartedAt = null;
      if (state.pendingInputs === 0) state.revision++;
      // Claude can batch several submitted inputs (including task notifications)
      // into one main turn. Child turns and /compact do not consume that batch.
      state.pendingInputs = 0;
    }
    if (!state.activeTurns.includes(e.turnId)) state.activeTurns.push(e.turnId);
    await save($);
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    if (!state.activeTurns.includes(e.turnId)) state.activeTurns.push(e.turnId);
    const startedAt = await $.clock.now();
    const policy = e.agentId === undefined ? await cachePolicy($) : null;
    if (e.agentId === undefined) {
      requestStartedAt = startedAt;
      state.cacheRequest = null;
    }
    await save($);
    const epoch = state.clockEpoch;
    const result = yield* next(e);
    if (e.agentId === undefined && epoch === state.clockEpoch)
      state.cacheRequest = { startedAt, model: result?.usage?.model ?? null, policy };
    await save($);
    return result;
  });
  on('turn.complete', async ($, e, next) => {
    state.activeTurns = state.activeTurns.filter(id => id !== e.turnId);
    if (e.agentId === undefined) {
      if (e.isAborted || e.reason !== 'answer') state.cacheRequest = null;
      // Without a model-request observation, completion is not a cache clock.
      if (requestStartedAt === null) state.cacheRequest = null;
      if (e.turnId === ordinaryTurnId && !e.isAborted && e.reason === 'answer') {
        state.ordinaryEndedAt = await $.clock.now();
        state.ordinaryRevision = state.revision;
        ordinaryTurnId = null;
      }
    }
    await save($);
    return next(e);
  });
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e);
    if (e.transcript_path) state.transcriptPath = e.transcript_path;
    await save($);
    return result;
  });
  on('classic.PostModelSwitch', async ($, e, next) => {
    state.revision++;
    state.cacheRequest = null;
    state.ordinaryEndedAt = null;
    state.ordinaryRevision = null;
    supersede();
    await save($);
    return next(e);
  });
  // Team/Enterprise policy plugins run first and continue classic.* and
  // session.compact past user-tier plugins, so this Mod never sees PreCompact
  // or PostCompact there. command.run reaches every tier and wraps /compact.
  let command = null;
  on('classic.PreCompact', async ($, e, next) => {
    if (command) {
      command.classic = true;
      return next(e);
    }
    const reason = await admit($, e.trigger);
    return reason ? { block: reason } : next(e);
  }).catch(async () => ({ block: 'Auto Compact could not verify the reservation' }));
  on('classic.PostCompact', async ($, e, next) => {
    if (state.compact?.status === 'running') state.compact.status = 'completed';
    await save($);
    return next(e);
  });
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    const reason = await admit($, 'manual');
    if (reason) return { text: reason };
    const operation = state.compact;
    const filled = (await $.session.usage()).context.tokens !== undefined;
    const current = command = { classic: false };
    let result;
    try { result = await next(e); } finally { command = null; }
    if (state.compact === operation && operation.status === 'running') {
      if (!current.classic && filled) await confirm($, operation);
      else {
        // Claude can run PreCompact and then return "not enough messages"
        // without PostCompact. A command returning is never evidence of compaction.
        operation.status = current.classic ? 'failed' : 'unknown';
        operation.reason = current.classic ? 'Claude returned without completing compaction'
          : 'Compaction completion could not be observed';
        await save($);
      }
    }
    return result;
  }).catch(async () => ({ text: 'Auto Compact could not verify the reservation' }));
}
