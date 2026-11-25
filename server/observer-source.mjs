// Runs inside Claude's Mod sandbox. No stdio interception, sockets or model calls.
// Only identifiers, activity and reported usage are persisted, never message text.
let state;
let configuration;
let writes = Promise.resolve();
let lastReceiptValue = null;
// Paseo can restart Claude's query inside the same launch, so a new observer
// generation reads this once from the ledger to remember what the previous one
// already checked; it is reset in registerObserver.
let carriedOver;
// One identity per preparation of a request. Requests from earlier releases
// and cancelled records carry no preparation, so their id and prepared time
// stand in for one.
const preparationKey = request => typeof request?.preparation === 'string'
  ? request.preparation : `${request.id}@${request.preparedAt}`;
// The /compact whose context reset is being read after the command returned.
// Input submitted then does not refill the context; the next model request does.
let confirming = null;
// Paseo and Claude read the same wall clock, which a VM host may step back by
// a second or two to correct drift (WSL2: observed -1.8 s every few minutes).
// Only a larger step is a rollback. Must equal CLOCK_STEP_TOLERANCE_MS in
// server/deadline.ts; it stays within the 30 s cache-deadline margin.
const CLOCK_STEP_TOLERANCE_MS = 10_000;
// A running observer rewrites its ledger this often, so the server can tell a
// live launch from an ended one: it ignores a ledger a minute old.
const HEARTBEAT_MS = 5_000;
// Must equal QUERY_RESTARTED_REFUSAL in server/observer.ts.
const QUERY_RESTARTED_REFUSAL = 'query_restarted';
const QUERY_RESTARTED_REASON = 'Claude query restarted before compaction ran';
// A new generation of the same launch (Paseo restarts Claude's query) must not
// check a leftover preparation again, so it adopts the previous generation's
// value. A missing, empty or unreadable ledger carries nothing over.
async function carryOver($) {
  carriedOver ??= (async () => {
    try {
      const ledger = JSON.parse(await $.fs.read(configuration.ledger));
      if (ledger?.launchId === state.launchId && typeof ledger.checkedPreparation === 'string')
        state.checkedPreparation = ledger.checkedPreparation;
    } catch {
      // Nothing to carry over.
    }
  })();
  return carriedOver;
}
async function save($) {
  // The first save of a generation must not erase what the previous one checked.
  await carryOver($);
  const now = await $.clock.now();
  if (state.updatedAt && now < state.updatedAt - CLOCK_STEP_TOLERANCE_MS) {
    state.cacheRequest = null;
    state.ordinaryEndedAt = null;
    state.clockEpoch++;
  }
  state.updatedAt = now;
  const snapshot = JSON.stringify(state);
  const compact = state.compact;
  if (compact?.id && compact.status !== 'running') compact.observedAt ??= now;
  const receipt = configuration.receipts && compact?.id && compact.status !== 'running'
    ? { path: configuration.receipts + '/' + encodeURIComponent(compact.id) + '.json',
        value: JSON.stringify({ id: compact.id, launchId: state.launchId, generation: state.generation,
          sessionId: state.sessionId, revision: compact.revision, status: compact.status,
          reason: compact.reason ?? null, observedAt: compact.observedAt,
          ...(compact.refusal ? { refusal: compact.refusal } : {}),
          ...(typeof compact.preparation === 'string' ? { preparation: compact.preparation } : {}),
          ...(compact.prepared ? { prepared: compact.prepared } : {}) }) } : null;
  writes = writes.catch(() => {}).then(async () => {
    // A receipt survives later activity and launch pruning. Partial reads are
    // treated as unavailable and retried by the server, never as completion.
    if (receipt && receipt.value !== lastReceiptValue) {
      await $.fs.write(receipt.path, receipt.value);
      // Heartbeats must not recreate a receipt after retention removes it.
      // Remember only a successful write so transient failures remain retryable.
      lastReceiptValue = receipt.value;
    }
    await $.fs.write(configuration.ledger, snapshot);
  });
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
  } catch {
    // An unreadable setting is not a policy: fall back to the default
    // assumption rather than blocking the reservation.
  }
  return { ttl: null, source: 'default' };
}

async function admit($, trigger) {
  // Adopt what the previous generation of this launch already checked before deciding.
  await carryOver($);
  let request;
  try { request = JSON.parse(await $.fs.read(configuration.request)); } catch { /* a missing or half-written request is no request */ }
  const key = request ? preparationKey(request) : null;
  const now = await $.clock.now();
  // Unrequested/manual/CLI compaction is observed but cannot complete an
  // automatic operation. The host also pins the public send's message/turn id.
  // A leftover request must refuse at most once, so one preparation is checked once.
  if (request?.status === 'cancelled' && request.id && trigger !== 'auto' &&
      state.checkedPreparation !== key) {
    state.checkedPreparation = key;
    state.compact = { id: request.id, status: 'failed', revision: state.revision, reason: 'Reservation cancelled' };
    await save($);
    return 'Auto Compact cancelled its pending /compact. Run /compact again to compact manually.';
  }
  let reason = null;
  let refusal = null;
  let prepared = null;
  if (!request || request.status !== 'prepared' || trigger === 'auto' ||
      state.checkedPreparation === key)
    state.compact = { id: null, status: 'running', revision: state.revision };
  else {
    // Paseo can restart Claude's query inside the same launch and resumed
    // session (for example after a pending thinking-level change). Record the
    // refused prepared identity so the server can attribute this refusal
    // without accepting a bare generation change or an unrelated cancellation.
    if (request.launchId === state.launchId &&
        typeof request.sessionId === 'string' && request.sessionId.length > 0 &&
        request.sessionId === state.sessionId &&
        typeof request.generation === 'string' && request.generation.length > 0 &&
        request.generation !== state.generation &&
        Number.isInteger(request.revision)) {
      reason = QUERY_RESTARTED_REASON;
      refusal = QUERY_RESTARTED_REFUSAL;
      prepared = { launchId: request.launchId, generation: request.generation,
        sessionId: request.sessionId, revision: request.revision };
    } else if (request.launchId !== state.launchId || request.generation !== state.generation ||
        request.sessionId !== state.sessionId) reason = 'Claude session changed';
    else if (request.revision !== state.revision || state.activeTurns.length || state.pendingInputs)
      reason = 'New conversation activity';
    else if (now > request.expiresAt || now < request.preparedAt - CLOCK_STEP_TOLERANCE_MS)
      reason = 'Reservation expired';
    else if (request.requireCache && (request.clockEpoch !== state.clockEpoch ||
        !Number.isFinite(request.cacheDeadline) || now >= request.cacheDeadline - 30_000))
      reason = 'Cache window passed';
    state.checkedPreparation = key;
    state.compact = { id: request.id,
      ...(typeof request.preparation === 'string' ? { preparation: request.preparation } : {}),
      status: reason ? 'failed' : 'running', revision: state.revision, reason,
      ...(refusal ? { refusal, prepared } : {}) };
  }
  state.cacheRequest = null;
  state.ordinaryEndedAt = null;
  state.ordinaryRevision = null;
  await save($);
  return reason;
}

// Time after /compact returns to wait for the live window to report the reset before failing.
const CONFIRMATION_WINDOW_MS = 10_000;
// How often to read the live window during that time.
const CONFIRMATION_READ_INTERVAL_MS = 500;
// The live window reports no fill from just after a compaction until the
// next response; a cancelled or no-op /compact leaves the old fill in place.
// It is read once as the command returns, then every 500 ms, until a later
// main model request starts (see turn.step) or 10 seconds pass.
async function confirm($, operation) {
  confirming = operation;
  const deadline = await $.clock.now() + CONFIRMATION_WINDOW_MS;
  const current = () => state.compact === operation && operation.status === 'running';
  // A reading is evidence of completion only: no fill while the operation is
  // still current and running. A rejected reading, a fill or a superseded
  // operation records nothing.
  let reading = null;
  const read = async () => {
    try {
      let reset;
      try {
        reset = (await $.session.usage()).context.tokens === undefined;
      } catch {
        // A rejected read is no evidence of a reset or a fill. It records
        // nothing and the interval still decides at the limit. Caught so it is
        // not unhandled.
        return;
      }
      // Nothing is awaited between this check and the write below.
      if (!reset || !current()) return;
      operation.status = 'completed';
      await save($);
    } finally {
      reading = null;
    }
  };
  const startReading = () => {
    if (reading) return reading;
    // A failed write is not retried here; the heartbeat saves this state again.
    reading = read().catch(() => {});
    return reading;
  };
  // The limit is decided here, never by a reading, so a reading that starts
  // before it and returns after it cannot defer the failure.
  const timer = await $.clock.every(CONFIRMATION_READ_INTERVAL_MS, async () => {
    if (!current()) { timer.cancel(); return; }
    // A reading is never awaited here, so one that does not settle cannot hold the ticks.
    startReading();
    const now = await $.clock.now();
    // A later model request may have recorded unknown while the clock was read.
    if (!current()) { timer.cancel(); return; }
    if (now < deadline) return;
    operation.status = 'failed';
    operation.reason = 'Claude returned without completing compaction';
    timer.cancel();
    await save($);
  });
  startReading();
}

export function registerObserver(on, config) {
  configuration = config;
  writes = Promise.resolve();
  lastReceiptValue = null;
  carriedOver = null;
  confirming = null;
  state = {
    version: 1, launchId: configuration.launchId, generation: crypto.randomUUID(),
    sessionId: null, updatedAt: 0, revision: 0, activeTurns: [], pendingInputs: 0,
    ordinaryEndedAt: null, ordinaryRevision: null, cacheRequest: null, transcriptPath: null,
    compact: null, closed: false, clockEpoch: 0,
    // A cancelled request blocks one late plugin /compact. Claude cannot tell
    // that command from the user's own, so later ones run as unrequested
    // compaction. This names the last preparation any /compact was checked
    // against, so each one is refused (or admitted) at most once.
    checkedPreparation: null,
  };
  let heartbeat;
  let requestStartedAt = null;
  let ordinaryTurnId = null;
  // A later main step proves that an SDK follow-up was folded into this turn.
  // Keep that evidence ephemeral until a successful completion commits it.
  let pendingCurrentTurnInputs = 0;
  let absorbedCurrentTurnInputs = 0;
  const supersede = () => {
    if (state.compact?.status === 'running') state.compact.status = 'unknown';
  };
  const isActiveOrdinaryTurn = e => ordinaryTurnId !== null && e.turnId === ordinaryTurnId &&
    state.activeTurns.includes(e.turnId);
  on('session.start', async ($, e, next) => {
    state.sessionId = await $.session.id();
    await save($);
    heartbeat?.cancel();
    heartbeat = await $.clock.every(HEARTBEAT_MS, async () => save($));
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
      const activeOrdinaryTurn = isActiveOrdinaryTurn(e);
      const delivered = activeOrdinaryTurn && e.wait !== true &&
        ['task-notification', 'peer', 'peer-send-message'].includes(e.origin?.kind);
      if (!e.text.trim().startsWith('/') && !delivered) {
        state.pendingInputs++;
        if (activeOrdinaryTurn && e.origin?.kind === 'sdk')
          pendingCurrentTurnInputs++;
      }
      state.cacheRequest = null;
      state.ordinaryEndedAt = null;
      state.ordinaryRevision = null;
      if (state.compact !== confirming) supersede();
      await save($);
    }
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !/^\/compact(?:\s|$)/.test(e.text.trim())) {
      ordinaryTurnId = e.turnId;
      requestStartedAt = null;
      pendingCurrentTurnInputs = 0;
      absorbedCurrentTurnInputs = 0;
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
    // A main model request may refill the context window, so a reset read
    // from now on cannot be told apart from a /compact that did nothing.
    if (e.agentId === undefined && confirming && state.compact === confirming && confirming.status === 'running') {
      confirming.status = 'unknown';
      confirming.reason = 'Compaction completion could not be observed';
    }
    if (!state.activeTurns.includes(e.turnId)) state.activeTurns.push(e.turnId);
    if (e.agentId === undefined && e.turnId === ordinaryTurnId) {
      absorbedCurrentTurnInputs += pendingCurrentTurnInputs;
      pendingCurrentTurnInputs = 0;
    }
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
      const ordinaryCompletion = e.turnId === ordinaryTurnId;
      if (e.isAborted || e.reason !== 'answer') state.cacheRequest = null;
      // Without a model-request observation, completion is not a cache clock.
      if (requestStartedAt === null) state.cacheRequest = null;
      if (ordinaryCompletion && !e.isAborted && e.reason === 'answer') {
        state.pendingInputs = Math.max(0, state.pendingInputs - absorbedCurrentTurnInputs);
        state.ordinaryEndedAt = await $.clock.now();
        state.ordinaryRevision = state.revision;
        ordinaryTurnId = null;
      }
      if (ordinaryCompletion) {
        pendingCurrentTurnInputs = 0;
        absorbedCurrentTurnInputs = 0;
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
