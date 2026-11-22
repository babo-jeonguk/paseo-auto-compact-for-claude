import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { waitFor } from './fixture.mjs';

const scheduled = (f, id, source) => waitFor(async () => {
  const row = await f.row(id);
  return row.status === 'scheduled' && row.dueAt && (!source || row.cache?.source === source) ? row : null;
}, `scheduled reservation${source ? ` (${source})` : ''}`);
const boundaries = rows => rows.filter(row => row.item.type === 'compaction' && row.item.status === 'completed');
// Waits for the plugin's outcome of `operationId`, then checks it against what
// Claude and Paseo recorded themselves, read apart from the plugin: Claude's
// receipt for that request, and a completed manual compaction boundary in the
// /compact message's own turn. Both mean success; anything less never does.
// Hosts differ in whether overlapping input stops a compaction, so the
// returned evidence says which way this one went.
async function settledAgainstEvidence(f, id, operationId) {
  const operation = await waitFor(async () => {
    const current = (await f.rpc('operation', { operationId })).operation;
    return ['succeeded', 'failed', 'unknown'].includes(current?.state) ? current : null;
  }, 'settled compaction outcome');
  // Every caller dispatched the command, so Claude recorded an outcome for it and Paseo one
  // command row. The plugin pre-creates an empty receipt file, which is not a record.
  const receipt = await f.receipt(id, operationId);
  assert.equal(receipt.id, operationId, `Claude recorded the request: ${JSON.stringify(receipt)}`);
  assert(['completed', 'failed', 'unknown'].includes(receipt.status), JSON.stringify(receipt));
  const rows = await f.timeline(id);
  const commands = rows.filter(row => row.item.type === 'user_message' && row.item.clientMessageId === operationId);
  assert.equal(commands.length, 1, '/compact is sent exactly once');
  const { turnId } = commands[0];
  assert(turnId, 'the command row names its turn');
  const boundary = rows.some(row => row.turnId === turnId && row.item.type === 'compaction' &&
    row.item.status === 'completed' && row.item.trigger === 'manual');
  const evidence = { outcome: operation.state, native: receipt.status, boundary };
  assert.equal(operation.state === 'succeeded', receipt.status === 'completed' && evidence.boundary, JSON.stringify(evidence));
  return { ...evidence, receipt };
}
// Starts Compact now on a conversation whose reply is scheduled and holds
// Claude's compaction request at the model; `next` holds the request after it.
async function heldCompaction(f, model, id) {
  const row = await scheduled(f, id);
  const compact = model.holdNext();
  const requestsBefore = model.count;
  const accepted = await f.rpc('now', { agentId: id, revision: row.revision, target: row.target });
  assert.equal(accepted.status, 'running'); assert(accepted.operationId);
  await waitFor(() => compact.requestId, 'in-flight compaction');
  return { row, compact, accepted, requestsBefore, next: model.holdNext() };
}
// Settles a held compaction that other input overlapped, then checks the
// follow-up: its own reply, one model request each, and when the compaction
// completed, a follow-up request that started only after Claude recorded that
// completion. Both times come from the same machine clock. What the host did
// with the input is its own behavior, returned for the report: whether the
// compaction request was answered or cut off, read once the model has seen
// that request close.
async function overlapSettled(f, model, id, held, label) {
  await waitFor(() => held.next.requestId, `${label}: its own request`);
  held.next.release();
  const { receipt, ...evidence } = await settledAgainstEvidence(f, id, held.accepted.operationId);
  await replied(f, id, held.next, `${label}: its own reply`);
  assert.equal(model.count - held.requestsBefore, 2, 'one compaction request and one for the follow-up');
  const compaction = model.requests.find(request => request.id === held.compact.requestId);
  const followUp = model.requests.find(request => request.id === held.next.requestId);
  if (evidence.outcome === 'succeeded')
    assert(followUp.at >= receipt.observedAt,
      `the follow-up started ${receipt.observedAt - followUp.at} ms before Claude recorded the compaction`);
  await waitFor(() => compaction.closedAt !== undefined, `${label}: the compaction request closed`);
  return { ...evidence, compactionRequest: compaction.cancelled ? 'cut off' : 'answered' };
}
// Paseo batches agent messages per recipient for two seconds. Waiting 750 ms
// longer shows whether this host delivers one while the compaction runs.
const AGENT_MESSAGE_BATCH_WAIT_MS = 2_750;
const replied = (f, id, request, label) => waitFor(async () => (await f.timeline(id)).some(row =>
  row.item.type === 'assistant_message' && row.item.text.includes(`SIMULATION_REPLY_${request.requestId}`)), label);

export const scenarios = [
  {
    name: 'native Claude transcript creates a real 55-minute reservation',
    async run(context) {
      const { fixture: f, model } = context;
      const { config } = await f.client.getDaemonConfig();
      assert.deepEqual((config.agents?.providers ?? config.providers).claude.command, [f.binary]);
      model.setTtl('1h');
      context.id = await f.agent();
      const reply = await f.turn(context.id, 'BASELINE: reply without tools.');
      assert.match(reply.text, /SIMULATION_REPLY_/);
      context.baseline = await waitFor(async () => {
        const row = await f.row(context.id);
        return row.status === 'scheduled' && row.cache?.source === 'transcript' ? row : null;
      }, 'observed one-hour TTL and scheduled reservation');
      assert.equal(context.baseline.cache.ttlMinutes, 60);
      assert(context.baseline.dueAt > Date.now() + 54 * 60_000);
      assert(context.baseline.dueAt < Date.now() + 56 * 60_000);
      context.sessionId = (await f.refresh(context.id)).persistence.sessionId;
    },
  },
  {
    name: 'batched background-agent notifications finish without phantom pending input and earn a new reservation',
    async run({ fixture: f, model }) {
      const id = await f.agent();
      model.notifyAgentsNext();
      await f.send(id, 'AGENT_BATCH: use the requested background agents, then reply without further tools.');
      const ledger = await waitFor(async () => {
        const state = await f.ledger(id);
        const agent = await f.refresh(id);
        return state.revision >= 3 && state.ordinaryEndedAt && state.activeTurns.length === 0 &&
          agent.status === 'idle' && !agent.activeTurn ? state : null;
      }, 'both background notifications consumed by the main session');
      assert.equal(ledger.pendingInputs, 0, 'all input was answered, so no pending-input warning should remain');
      const row = await f.row(id);
      assert.notEqual(row.status, 'busy');
      assert.notEqual(row.busyReason, 'input');
      assert.equal(row.inputIdleSince, null);
      // The notification turn ended after the user's turn and earns its own reservation.
      await scheduled(f, id);
      await f.rpc('toggle', { agentId: id, enabled: false });
    },
  },
  {
    name: 'a background notification absorbed into the active turn leaves no pending input and can schedule',
    async run({ fixture: f, model }) {
      const id = await f.agent();
      await f.client.setAgentMode(id, 'bypassPermissions');
      model.notifyDuringTurnNext();
      await f.send(id, 'MID_TURN_NOTIFICATION: run the synthetic waits and then reply without other tools.');
      const ledger = await waitFor(async () => {
        const state = await f.ledger(id), agent = await f.refresh(id);
        return state.revision >= 2 && state.ordinaryEndedAt && state.transcriptPath &&
          !state.activeTurns.length && agent.status === 'idle' && !agent.activeTurn ? state : null;
      }, 'background notification handled within the main turn');
      const transcript = (await readFile(ledger.transcriptPath, 'utf8')).split('\n').flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      assert(transcript.some(row => row.type === 'queue-operation' && row.reason === 'absorbed_mid_turn'),
        'The notification must actually be absorbed into this turn, rather than handled by a fresh turn');
      assert.equal(ledger.pendingInputs, 0, 'an already delivered notification must not remain queued');
      const row = await scheduled(f, id);
      assert.equal(row.inputIdleSince, null);
      assert.notEqual(row.busyReason, 'input');
      await f.rpc('toggle', { agentId: id, enabled: false });
    },
  },
  {
    name: 'a background shell outlives compaction and its completion notification is delivered without a resend',
    async run({ fixture: f, model }) {
      await f.settings({ idleMinutes: 50 });
      const id = await f.agent();
      model.backgroundShellNext();
      await f.turn(id, 'BACKGROUND_SHELL_COMPACT: start the synthetic background shell, then reply without further tools.');
      const agent = await f.refresh(id);
      const nativeBackground = typeof f.client.listAgentBackgroundWork === 'function';
      let shellId = null;
      if (nativeBackground) {
        const work = await waitFor(async () => {
          const rows = await f.client.listAgentBackgroundWork(id);
          return rows.length ? rows : null;
        }, 'background shell still running', 30_000);
        shellId = work[0].id;
      }
      const row = await scheduled(f, id);
      const sessionId = agent.persistence.sessionId;
      const completedBefore = boundaries(await f.timeline(id)).length;
      const requestsBefore = model.count;
      // Paseo 0.16 reports hidden background work; older hosts do not expose it.
      if (typeof agent.backgroundWork?.count === 'number')
        assert(agent.backgroundWork.count >= 1, 'the shell must still be running at Compact now');
      const accepted = await f.rpc('now', { agentId: id, revision: row.revision, target: row.target });
      assert.equal(accepted.status, 'running'); assert(accepted.operationId);
      await waitFor(async () => {
        const current = (await f.rpc('operation', { operationId: accepted.operationId })).operation;
        return current?.state === 'succeeded' ? current : null;
      }, 'compaction while background work runs', 120_000);
      assert.equal((await f.refresh(id)).persistence.sessionId, sessionId);
      const compactedTimeline = await f.timeline(id);
      assert.equal(boundaries(compactedTimeline).length, completedBefore + 1);
      const boundaryAt = compactedTimeline.findIndex(entry =>
        entry.item.type === 'compaction' && entry.item.status === 'completed');
      assert(boundaryAt >= 0, 'a native compaction boundary must be on the timeline');
      const notification = await waitFor(() => model.requests.slice(requestsBefore).find(request =>
        request.texts?.some(text => /task-notification|SYSTEM NOTIFICATION/i.test(text) &&
          /completed/i.test(text) && (!shellId || text.includes(shellId)))),
        'background completion notification request', 90_000);
      if (shellId)
        assert(notification.texts.some(text => text.includes(shellId)),
          'the completion notification must name the background shell');
      await waitFor(async () => {
        const rows = await f.timeline(id);
        return rows.length > boundaryAt && rows.slice(boundaryAt + 1)
          .some(entry => entry.item.type === 'assistant_message') ? rows : null;
      }, 'assistant reply after the completion notification', 90_000);
      const state = await waitFor(async () => {
        const ledger = await f.ledger(id);
        return ledger.pendingInputs === 0 && ledger.activeTurns.length === 0 &&
          ledger.compact?.status === 'completed' ? ledger : null;
      }, 'ledger settled after the notification turn', 30_000);
      assert.equal(state.pendingInputs, 0, 'a delivered completion notification must not remain queued');
      const fresh = await scheduled(f, id);
      assert.notEqual(fresh.revision, row.revision, 'the notification turn is new activity');
      if (nativeBackground)
        await waitFor(async () => (await f.client.listAgentBackgroundWork(id)).length === 0,
          'background shell end', 90_000);
      const commands = (await f.timeline(id)).filter(entry =>
        entry.item.type === 'user_message' && entry.item.text === '/compact');
      assert.equal(commands.length, 1, 'compaction must not be resent');
      await f.rpc('toggle', { agentId: id, enabled: false });
    },
  },
  {
    name: '50-minute automatic delay is preserved; manual compaction works below the token threshold',
    async run({ fixture: f, id, baseline }) {
      await f.settings({ idleMinutes: 50 });
      const row = await scheduled(f, id);
      assert.equal(baseline.dueAt - row.dueAt, 300_000);
      await f.settings({ threshold: 600_000 });
      const manualId = await f.agent();
      await f.turn(manualId, 'MANUAL_BELOW_THRESHOLD: reply without tools.');
      const tooSmall = await scheduled(f, manualId);
      assert(tooSmall.tokens < 600_000);
      const sessionId = (await f.refresh(manualId)).persistence.sessionId;
      const accepted = await f.rpc('now', { agentId: manualId, revision: tooSmall.revision });
      assert.equal(accepted.status, 'running'); assert(accepted.operationId);
      await waitFor(async () => {
        const current = await f.row(manualId);
        return current.status === 'completed' && current.operationId === accepted.operationId;
      }, 'manual compaction below threshold');
      assert.equal((await f.refresh(manualId)).persistence.sessionId, sessionId);
      assert.equal(boundaries(await f.timeline(manualId)).length, 1);
      await f.settings({ threshold: 400_000 });
      assert.equal((await f.settings()).idleMinutes, 50);
    },
  },
  {
    name: 'global, provider and conversation switches control automation independently',
    async run({ fixture: f, id }) {
      await f.settings({ enabled: false });
      assert.equal((await f.row(id)).status, 'disabled');
      await f.settings({ enabled: true, disabledProviders: ['claude'] });
      assert.equal((await f.row(id)).status, 'disabled');
      await f.settings({ disabledProviders: [] });
      await f.rpc('toggle', { agentId: id, enabled: false });
      assert.equal((await f.row(id)).enabled, false);
      await f.rpc('toggle', { agentId: id, enabled: true });
      await scheduled(f, id);
    },
  },
  {
    name: 'Skip and Undo keep the same deadline; new input cancels the previous reservation',
    async run({ fixture: f, model, id }) {
      const row = await scheduled(f, id);
      assert.equal((await f.rpc('skip', { agentId: id, revision: row.revision })).changed, true);
      const skipped = await f.row(id);
      assert.equal(skipped.status, 'skipped'); assert(skipped.undoSkip?.id);
      assert.equal((await f.rpc('undo-skip', { agentId: id, revision: row.revision, skipId: skipped.undoSkip.id })).changed, true);
      assert.equal((await f.row(id)).dueAt, row.dueAt);
      const gate = model.holdNext();
      await f.send(id, 'NEW_INPUT: cancel the old timer and reply without tools.');
      await waitFor(() => gate.requestId, 'new user request');
      const busy = await f.row(id);
      assert.equal(busy.status, 'busy'); assert.equal(busy.dueAt, null);
      gate.release();
      const next = await scheduled(f, id);
      assert.notEqual(next.revision, row.revision);
      assert.equal((await f.rpc('undo-skip', { agentId: id, revision: row.revision, skipId: skipped.undoSkip.id })).changed, false);
    },
  },
  {
    name: 'real automatic timer compacts once in the same native session without a manual RPC',
    async run({ fixture: f, id, sessionId }) {
      await f.settings({ idleMinutes: 1 });
      await scheduled(f, id);
      await waitFor(async () => (await f.row(id)).status === 'completed', 'automatic one-minute compaction', 100_000);
      assert.equal((await f.refresh(id)).persistence.sessionId, sessionId);
      assert(boundaries(await f.timeline(id)).length > 0);
      const before = boundaries(await f.timeline(id)).length;
      await new Promise(resolve => setTimeout(resolve, 11_000));
      const row = await f.row(id);
      assert.equal(row.status, 'completed'); assert.equal(row.dueAt, null);
      assert.equal(boundaries(await f.timeline(id)).length, before);
    },
  },
  {
    name: 'explicit Compact now completes and keeps the native session',
    async run({ fixture: f, id, sessionId }) {
      await f.settings({ idleMinutes: 50 });
      await f.turn(id, 'MANUAL_READY: reply without tools.');
      const row = await scheduled(f, id);
      const accepted = await f.rpc('now', { agentId: id, revision: row.revision });
      assert.equal(accepted.status, 'running'); assert(accepted.operationId);
      await waitFor(async () => {
        const current = await f.row(id);
        return current.status === 'completed' && current.operationId === accepted.operationId;
      }, 'explicit manual compaction');
      assert.equal((await f.refresh(id)).persistence.sessionId, sessionId);
    },
  },
  {
    name: 'manual operation is idempotent and remains queryable after new activity',
    async run({ fixture: f, model }) {
      const id = await f.agent();
      await f.turn(id, 'IDEMPOTENCY_READY: reply without tools.');
      const row = await scheduled(f, id);
      const input = { agentId: id, revision: row.revision, target: row.target, operationId: randomUUID() };
      const gate = model.holdNext();
      const accepted = await f.rpc('now', input);
      assert.equal(accepted.status, 'running');
      assert.equal(accepted.operationId, input.operationId);
      assert.equal(accepted.operation.id, input.operationId);
      await waitFor(() => gate.requestId, 'in-flight idempotent compaction');
      const duplicate = await f.rpc('now', input);
      assert.equal(duplicate.operation.id, input.operationId);
      assert(['dispatching', 'observing'].includes(duplicate.operation.state));
      const conflict = await f.rpc('now', { ...input, revision: `${input.revision}-different` });
      assert.equal(conflict.status, 'blocked');
      assert.equal(conflict.code, 'idempotency_conflict');
      assert.equal(conflict.operationId, null);
      assert.equal(conflict.operation, null);
      gate.release();
      const finished = await waitFor(async () => {
        const operation = (await f.rpc('operation', { operationId: input.operationId })).operation;
        return operation?.state === 'succeeded' ? operation : null;
      }, 'idempotent operation completion');
      const completedDuplicate = await f.rpc('now', input);
      assert.equal(completedDuplicate.operation.id, input.operationId);
      assert.equal(completedDuplicate.operation.state, 'succeeded');
      assert.equal(boundaries(await f.timeline(id)).length, 1);
      await f.turn(id, 'IDEMPOTENCY_LATER_ACTIVITY: reply without tools.');
      assert.deepEqual((await f.rpc('operation', { operationId: input.operationId })).operation, finished);
      assert.equal(boundaries(await f.timeline(id)).length, 1);
      await f.rpc('toggle', { agentId: id, enabled: false });
    },
  },
  {
    name: 'an in-flight operation recovers after plugin reload without resending',
    async run({ fixture: f, model }) {
      const id = await f.agent();
      await f.turn(id, 'RECOVERY_READY: reply without tools.');
      const row = await scheduled(f, id);
      const operationId = randomUUID();
      const gate = model.holdNext();
      const before = model.count;
      const accepted = await f.rpc('now', { agentId: id, revision: row.revision, target: row.target, operationId });
      assert.equal(accepted.status, 'running');
      assert.equal(accepted.operation.id, operationId);
      await waitFor(() => gate.requestId, 'in-flight recovery compaction');
      assert.equal(model.count, before + 1);
      assert.equal((await f.client.reloadPlugin('auto-compact-for-claude')).status, 'running');
      gate.release();
      const recovered = await waitFor(async () => {
        const operation = (await f.rpc('operation', { operationId })).operation;
        return operation?.state === 'succeeded' ? operation : null;
      }, 'operation reconciled after plugin reload', 60_000);
      assert.equal(recovered.id, operationId);
      assert.equal(model.count, before + 1, 'recovery must not send another model request');
      const receipt = await f.receipt(id, operationId);
      assert.equal(receipt.id, operationId);
      assert.equal(receipt.status, 'completed');
      const timeline = await f.timeline(id);
      const command = timeline.find(entry => entry.item.type === 'user_message' && entry.item.clientMessageId === operationId);
      assert(command?.turnId, 'operation ID must identify the compaction command turn');
      const completed = boundaries(timeline);
      assert.equal(completed.length, 1);
      assert.equal(completed[0].turnId, command.turnId);
      await f.rpc('toggle', { agentId: id, enabled: false });
    },
  },
  {
    name: 'two conversations compact at the same time; each operation is linked only to its own evidence',
    async run({ fixture: f, model }) {
      const a = await f.agent(), b = await f.agent();
      await f.turn(a, 'CONCURRENT_A_READY: reply without tools.');
      await f.turn(b, 'CONCURRENT_B_READY: reply without tools.');
      const rowA = await scheduled(f, a), rowB = await scheduled(f, b);
      const sessionA = (await f.refresh(a)).persistence.sessionId;
      const sessionB = (await f.refresh(b)).persistence.sessionId;
      const before = model.count;
      const operationA = randomUUID(), operationB = randomUUID();
      const gate = model.holdNext();
      const acceptedA = await f.rpc('now', { agentId: a, revision: rowA.revision, target: rowA.target, operationId: operationA });
      assert.equal(acceptedA.status, 'running');
      assert.equal(acceptedA.code, 'accepted');
      assert.equal(acceptedA.operationId, operationA);
      await waitFor(() => gate.requestId, 'in-flight compaction for conversation A');
      assert.equal(model.count, before + 1);
      const heldA = (await f.rpc('operation', { operationId: operationA })).operation;
      assert(['dispatching', 'observing'].includes(heldA.state), JSON.stringify(heldA));
      // A's compaction is now waiting on the held model request. B must not
      // queue behind it: accepted, sent, and finished on its own.
      const acceptedB = await f.rpc('now', { agentId: b, revision: rowB.revision, target: rowB.target, operationId: operationB });
      assert.equal(acceptedB.status, 'running');
      assert.equal(acceptedB.code, 'accepted');
      assert.equal(acceptedB.operationId, operationB);
      await waitFor(async () => {
        const operation = (await f.rpc('operation', { operationId: operationB })).operation;
        return operation?.state === 'succeeded' ? operation : null;
      }, 'conversation B compaction while A is still held');
      const stillHeldA = (await f.rpc('operation', { operationId: operationA })).operation;
      assert(['dispatching', 'observing'].includes(stillHeldA.state),
        `A must still be pending while B completes, not ${stillHeldA.state}`);
      // A second request for A under a new ID returns A's existing operation.
      const duplicateA = await f.rpc('now', {
        agentId: a, revision: rowA.revision, target: rowA.target, operationId: randomUUID() });
      assert.equal(duplicateA.code, 'existing');
      assert.equal(duplicateA.operationId, operationA);
      assert.equal(model.count, before + 2, 'the existing-operation answer and B together must send exactly two requests');
      gate.release();
      await waitFor(async () => {
        const operation = (await f.rpc('operation', { operationId: operationA })).operation;
        return operation?.state === 'succeeded' ? operation : null;
      }, 'conversation A compaction after release');
      assert.equal(model.count, before + 2, 'each conversation must send exactly one model request');
      for (const [id, operationId, otherOperationId, sessionId] of
        [[a, operationA, operationB, sessionA], [b, operationB, operationA, sessionB]]) {
        const receipt = await f.receipt(id, operationId);
        assert.equal(receipt.id, operationId);
        assert.equal(receipt.status, 'completed');
        const timeline = await f.timeline(id);
        const command = timeline.find(entry => entry.item.type === 'user_message' && entry.item.clientMessageId === operationId);
        assert(command?.turnId, 'the operation ID must identify its own compaction command turn');
        const completed = boundaries(timeline);
        assert.equal(completed.length, 1, 'only this conversation\'s compaction boundary may complete');
        assert.equal(completed[0].turnId, command.turnId, 'the receipt and boundary must belong to the same command');
        assert(!JSON.stringify(timeline).includes(otherOperationId),
          'another conversation\'s operation must not appear on this timeline');
        assert.equal((await f.refresh(id)).persistence.sessionId, sessionId,
          'concurrent compaction must keep each native session');
      }
      await f.rpc('toggle', { agentId: a, enabled: false });
      await f.rpc('toggle', { agentId: b, enabled: false });
    },
  },
  {
    name: 'aged terminal records and receipts are pruned without replay; recent and pending records survive',
    async run({ fixture: f, model }) {
      const id = await f.agent();
      await f.turn(id, 'RETENTION_READY: reply without tools.');
      const row = await scheduled(f, id);
      const operationId = randomUUID();
      await f.rpc('now', { agentId: id, revision: row.revision, target: row.target, operationId });
      await waitFor(async () => (await f.rpc('operation', { operationId })).operation?.state === 'succeeded', 'retention compaction');
      const receipt = await f.receipt(id, operationId);
      const statePath = join(f.home, 'plugin-data/auto-compact-for-claude/state.json');
      const receiptPath = (agentId, receiptId) => join(f.home, 'plugin-data/auto-compact-for-claude/observers',
        createHash('sha256').update(agentId).digest('hex'), 'receipts', `${encodeURIComponent(receiptId)}.json`);
      const recentId = randomUUID(), orphanId = randomUUID(), recentOrphanId = randomUUID();
      // Age and clone records only while the plugin is stopped. These are
      // retention fixtures, not simulated passage of real reservation time.
      await f.client.disablePlugin('auto-compact-for-claude');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const old = state.operations.find(entry => entry.id === operationId);
      assert(old);
      old.createdAt = old.updatedAt = Date.now() - 8 * 24 * 60 * 60_000;
      state.operations.push({ ...structuredClone(old), id: recentId, agentId: 'retention-recent-fixture',
        createdAt: Date.now(), updatedAt: Date.now() });
      await mkdir(join(receiptPath('retention-recent-fixture', recentId), '..'), { recursive: true });
      await writeFile(receiptPath('retention-recent-fixture', recentId), JSON.stringify({ ...receipt, id: recentId }));
      await writeFile(receiptPath(id, orphanId), JSON.stringify({ ...receipt, id: orphanId, observedAt: Date.now() - 8 * 24 * 60 * 60_000 }));
      await writeFile(receiptPath(id, recentOrphanId), JSON.stringify({ ...receipt, id: recentOrphanId, observedAt: Date.now() }));
      await writeFile(statePath, JSON.stringify(state));
      const requests = model.count;
      assert.equal((await f.client.enablePlugin('auto-compact-for-claude')).status, 'running');
      await waitFor(async () => !(await f.rpc('operation', { operationId })).operation, 'old operation cleanup');
      await assert.rejects(access(receiptPath(id, operationId)), { code: 'ENOENT' });
      await assert.rejects(access(receiptPath(id, orphanId)), { code: 'ENOENT' });
      await access(receiptPath(id, recentOrphanId));
      assert((await f.rpc('operation', { operationId: recentId })).operation);
      await access(receiptPath('retention-recent-fixture', recentId));
      const latest = await f.row(id);
      const guarded = await f.rpc('now', { agentId: id, revision: latest.revision, target: latest.target, operationId: randomUUID() });
      assert.equal(guarded.code, 'existing', `pruning must preserve the same-activity guard: ${guarded.detail}`);
      assert.equal(model.count, requests, 'cleanup and the guard must not resend compaction');

      await f.client.disablePlugin('auto-compact-for-claude');
      const pendingState = JSON.parse(await readFile(statePath, 'utf8'));
      const pendingId = randomUUID(), future = Date.now() + 60 * 60_000;
      pendingState.operations.push({ ...structuredClone(old), id: pendingId, agentId: 'retention-pending-fixture',
        state: 'requested', result: null, sendBy: future, nextAttemptAt: future });
      await mkdir(join(receiptPath('retention-pending-fixture', pendingId), '..'), { recursive: true });
      await writeFile(receiptPath('retention-pending-fixture', pendingId), JSON.stringify({ ...receipt, id: pendingId }));
      await writeFile(statePath, JSON.stringify(pendingState));
      assert.equal((await f.client.enablePlugin('auto-compact-for-claude')).status, 'running');
      assert((await f.rpc('operation', { operationId: pendingId })).operation, 'pending record must survive');
      await access(receiptPath('retention-pending-fixture', pendingId));
      assert.equal(model.count, requests, 'pending recovery must not resend');
      // Remove only the synthetic pending record while stopped so it cannot
      // block unrelated later scenarios.
      await f.client.disablePlugin('auto-compact-for-claude');
      const finalState = JSON.parse(await readFile(statePath, 'utf8'));
      finalState.operations = finalState.operations.filter(entry => entry.id !== pendingId);
      await writeFile(statePath, JSON.stringify(finalState));
      await rm(receiptPath('retention-pending-fixture', pendingId));
      assert.equal((await f.client.enablePlugin('auto-compact-for-claude')).status, 'running');
      await f.rpc('toggle', { agentId: id, enabled: false });
    },
  },
  {
    name: 'input during compaction keeps its own reply and cannot be mistaken for compact success',
    async run({ fixture: f, model, id }) {
      await f.turn(id, 'RACE_READY: reply without tools.');
      const row = await scheduled(f, id);
      const compact = model.holdNext();
      const operation = await f.rpc('now', { agentId: id, revision: row.revision });
      assert.equal(operation.status, 'running'); assert(operation.operationId);
      await waitFor(() => compact.requestId, 'in-flight compaction');
      const user = model.holdNext();
      await f.send(id, 'INPUT_DURING_COMPACT: reply without tools.', { activeTurnBehavior: 'interrupt' });
      compact.release();
      await waitFor(() => user.requestId, 'overlapping user request');
      const result = await waitFor(async () => {
        const receipt = (await f.ledger(id)).compact;
        return receipt && receipt.status !== 'running' ? receipt : null;
      }, 'native overlapping compact outcome');
      // Claude can acknowledge cancellation before the overlapping input is
      // observed. A confirmed cancellation is failed; an uncertain outcome is
      // unknown. Neither may be promoted to successful compaction.
      assert(result.status === 'unknown' || (result.status === 'failed' &&
        /cancel|without completing|did not complete/i.test(result.reason)), JSON.stringify(result));
      // The native receipt can settle before the worker persists its outcome.
      // Keep the user request held until the original operation has settled and
      // the row reflects that the conversation is still busy.
      await waitFor(async () => {
        const current = (await f.rpc('operation', { operationId: operation.operationId })).operation;
        assert.notEqual(current?.state, 'succeeded', 'overlapping input must not complete compaction');
        if (!current || !['failed', 'unknown'].includes(current.state)) return null;
        return (await f.row(id)).status === 'busy';
      }, 'settled compaction and busy overlapping input');
      user.release();
      await waitFor(async () => (await f.timeline(id)).some(row => row.item.type === 'assistant_message' &&
        row.item.text.includes(`SIMULATION_REPLY_${user.requestId}`)), 'the user\'s own assistant reply');
      const fresh = await scheduled(f, id);
      assert.notEqual(fresh.revision, row.revision);
      const settled = (await f.rpc('operation', { operationId: operation.operationId })).operation;
      assert(['failed', 'unknown'].includes(settled?.state), JSON.stringify(settled));
    },
  },
  {
    name: 'input steered into a compaction gets its own reply, and the outcome agrees with what Claude and Paseo recorded',
    async run({ fixture: f, model }) {
      await f.settings({ idleMinutes: 50 });
      const id = await f.agent();
      await f.turn(id, 'STEER_READY: reply without tools.');
      const held = await heldCompaction(f, model, id);
      // Paseo 0.16.2 and later deliver a steer after the compaction; earlier hosts stop it.
      try { await f.send(id, 'STEERED_DURING_COMPACT: reply without tools.', { activeTurnBehavior: 'steer' }); }
      finally { held.compact.release(); }
      const evidence = await overlapSettled(f, model, id, held, 'the steered message');
      const fresh = await scheduled(f, id);
      assert.notEqual(fresh.revision, held.row.revision);
      await f.rpc('toggle', { agentId: id, enabled: false });
      return evidence;
    },
  },
  {
    name: 'a message from another agent during a compaction gets its own reply, and the outcome agrees with what Claude and Paseo recorded',
    async run({ fixture: f, model }) {
      await f.settings({ idleMinutes: 50 });
      const id = await f.agent(), source = await f.agent();
      await f.rpc('toggle', { agentId: source, enabled: false });
      await f.turn(id, 'AGENT_MESSAGE_READY: reply without tools.');
      const held = await heldCompaction(f, model, id);
      try {
        await f.send(id, 'AGENT_MESSAGE_DURING_COMPACT: reply without tools.', { sourceAgentId: source });
        // No event marks a message that was not delivered, so this keeps the compaction
        // open past the batch window before letting it finish.
        await new Promise(resolve => setTimeout(resolve, AGENT_MESSAGE_BATCH_WAIT_MS));
      } finally { held.compact.release(); }
      const evidence = await overlapSettled(f, model, id, held, 'the agent message');
      await f.rpc('toggle', { agentId: id, enabled: false });
      return evidence;
    },
  },
  {
    name: 'after a thinking-level change, the observer keeps working and Compact now completes on its own evidence',
    async run({ fixture: f }) {
      await f.settings({ idleMinutes: 50 });
      const id = await f.agent();
      await f.client.setAgentThinkingOption(id, 'low');
      await f.turn(id, 'EFFORT_READY: reply without tools.');
      const before = await f.ledger(id);
      // Paseo 0.17 applies this to a running Claude query; otherwise the next
      // query restarts. The reply below absorbs either before compaction.
      await f.client.setAgentThinkingOption(id, 'high');
      await f.turn(id, 'EFFORT_CHANGED: reply without tools.');
      const row = await scheduled(f, id);
      const prepared = await f.ledger(id);
      const accepted = await f.rpc('now', { agentId: id, revision: row.revision, target: row.target });
      assert.equal(accepted.status, 'running'); assert(accepted.operationId);
      const { receipt, ...evidence } = await settledAgainstEvidence(f, id, accepted.operationId);
      assert.equal(evidence.outcome, 'succeeded', JSON.stringify(evidence));
      assert.equal(receipt.launchId, prepared.launchId);
      assert.equal(receipt.generation, prepared.generation);
      await f.rpc('toggle', { agentId: id, enabled: false });
      return { ...evidence, observerKept: prepared.launchId === before.launchId && prepared.generation === before.generation };
    },
  },
  {
    name: 'new responses re-detect five-minute and mixed TTL, then recover to one hour',
    async run({ fixture: f, model, id }) {
      await f.settings({ idleMinutes: 55 });
      for (const ttl of ['5m', 'mixed']) {
        model.setTtl(ttl);
        await f.turn(id, `TTL_${ttl}: reply without tools.`);
        const row = await waitFor(async () => {
          const value = await f.row(id);
          return value.status === 'blocked' && /5-minute/.test(value.detail) &&
            value.cache?.source === 'transcript' && value.cache.ttlMinutes === 5 ? value : null;
        }, `${ttl} transcript TTL`);
        assert.equal(row.status, 'blocked'); assert.match(row.detail, /5-minute/);
        assert.equal((await f.settings()).idleMinutes, 55);
        if (ttl === 'mixed') assert.equal(row.cache.mixed, true);
      }
      model.setTtl('1h'); await f.turn(id, 'TTL_RECOVERY: reply without tools.');
      assert.equal((await scheduled(f, id, 'transcript')).cache.ttlMinutes, 60);
    },
  },
  {
    name: 'missing TTL keeps 55- and 50-minute scheduling with a disclosed default',
    async run(context) {
      const { fixture: f, model } = context;
      model.setTtl('missing');
      context.fallbackId = await f.agent();
      await f.turn(context.fallbackId, 'TTL_MISSING: reply without tools.');
      const fiftyFive = await scheduled(f, context.fallbackId, 'default');
      assert.equal(fiftyFive.cache.ttlMinutes, 60); assert.match(fiftyFive.detail, /assumed/);
      await f.settings({ idleMinutes: 50 });
      const fifty = await scheduled(f, context.fallbackId, 'default');
      assert.equal(fiftyFive.dueAt - fifty.dueAt, 300_000);
    },
  },
  {
    name: 'configured TTL works without transcript data and environment overrides merged settings',
    async run(context) {
      const { fixture: f, model } = context;
      model.setTtl('missing');
      await f.claudeSettings({ promptCacheTtl: '1h' });
      context.settingsId = await f.agent();
      await f.turn(context.settingsId, 'TTL_SETTINGS: reply without tools.');
      assert.equal((await scheduled(f, context.settingsId, 'settings')).cache.ttlMinutes, 60);
      await f.claudeSettings({ promptCacheTtl: '5m' });
      context.envId = await f.agent('claude-env');
      await f.turn(context.envId, 'TTL_ENVIRONMENT: reply without tools.');
      assert.equal((await scheduled(f, context.envId, 'environment')).cache.ttlMinutes, 60);
      await f.claudeSettings({}); model.setTtl('1h');
    },
  },
  {
    name: 'a session whose observer never loads is missing only after a reply finishes, and Compact now is refused unsent',
    async run({ fixture: f, model }) {
      // Claude Code does not load Mods while hooks are disabled.
      await f.claudeSettings({ disableAllHooks: true });
      try {
        const id = await f.agent();
        await f.turn(id, 'NO_OBSERVER: reply without tools.');
        assert.deepEqual(await f.ledger(id), {}, 'the observer must not have loaded');
        // The reply started and finished after the launch was prepared, so the
        // placeholder is no longer a starting observer.
        const row = await waitFor(async () => {
          const value = await f.row(id);
          return value.status === 'blocked' && value.blockedReason === 'observer_missing' ? value : null;
        }, 'missing observer after a completed reply');
        assert(row.tokens !== null);
        const requests = model.count, operationId = randomUUID();
        const accepted = await f.rpc('now', { agentId: id, revision: row.revision, target: row.target, operationId });
        assert.equal(accepted.status, 'running');
        // Refused at once: failed before dispatch, not retried until its send deadline expires.
        const operation = await waitFor(async () => {
          const value = (await f.rpc('operation', { operationId })).operation;
          return value && value.state !== 'requested' && value.state !== 'dispatching' ? value : null;
        }, 'refused Compact now');
        assert.equal(operation.state, 'failed');
        assert.equal(operation.result.code, 'failed_before_dispatch');
        assert.equal(model.count, requests, 'nothing may be sent to the model');
        assert.equal((await f.timeline(id)).filter(entry =>
          entry.item.type === 'user_message' && entry.item.text === '/compact').length, 0);
        await f.rpc('toggle', { agentId: id, enabled: false });
      } finally { await f.claudeSettings({}); }
    },
  },
  {
    name: 'plugin reload preserves settings, conversation OFF and existing session without replay',
    async run({ fixture: f, model, id, sessionId }) {
      await f.rpc('toggle', { agentId: id, enabled: false });
      const settings = await f.settings(), requests = model.count;
      assert.equal((await f.client.reloadPlugin('auto-compact-for-claude')).status, 'running');
      assert.deepEqual(await f.settings(), settings);
      assert.equal((await f.row(id)).enabled, false);
      assert.equal((await f.refresh(id)).persistence.sessionId, sessionId);
      assert.equal(model.count, requests);
    },
  },
  {
    name: 'an overdue reservation is expired after plugin downtime instead of replayed',
    async run({ fixture: f, model, id, fallbackId, settingsId, envId }) {
      for (const other of [id, fallbackId, settingsId, envId])
        await f.rpc('toggle', { agentId: other, enabled: false });
      await f.settings({ idleMinutes: 1 });
      await f.turn(id, 'MISSED_WINDOW: reply without tools.');
      await f.rpc('toggle', { agentId: id, enabled: true });
      const row = await scheduled(f, id);
      await f.client.disablePlugin('auto-compact-for-claude');
      const requests = model.count;
      console.log('Waiting for the real reservation deadline while Auto Compact is stopped...');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, row.dueAt + 2000 - Date.now())));
      assert.equal((await f.client.enablePlugin('auto-compact-for-claude')).status, 'running');
      const expired = await f.row(id);
      assert.equal(expired.status, 'expired'); assert.equal(expired.dueAt, null);
      assert.equal(model.count, requests);
      await f.settings({ idleMinutes: 50 });
      await f.rpc('toggle', { agentId: id, enabled: false });
    },
  },
  {
    name: 'Compact now right after a pending thinking-level change fails promptly as a query restart without compacting',
    async run({ fixture: f, model }) {
      await f.settings({ idleMinutes: 50 });
      const id = await f.agent();
      await f.client.setAgentThinkingOption(id, 'low');
      await f.turn(id, 'EFFORT_COMPACT_NOW: reply without tools.');
      const row = await scheduled(f, id);
      const before = await f.ledger(id);
      await f.client.setAgentThinkingOption(id, 'high');
      const requestsBefore = model.count;
      const operationId = randomUUID();
      const accepted = await f.rpc('now', { agentId: id, revision: row.revision, target: row.target, operationId });
      assert.equal(accepted.status, 'running');
      assert.equal(accepted.operationId, operationId);
      const operation = await waitFor(async () => {
        const current = (await f.rpc('operation', { operationId })).operation;
        return current && ['succeeded', 'failed', 'unknown'].includes(current.state) ? current : null;
      }, 'prompt query-restart refusal for Compact now');
      assert.equal(operation.state, 'failed', JSON.stringify(operation));
      assert.equal(operation.result?.code, 'failed_after_dispatch', JSON.stringify(operation));
      assert.match(operation.result?.message ?? '', /query restarted/i, JSON.stringify(operation));
      const after = await f.ledger(id);
      assert.equal(after.launchId, before.launchId);
      assert.notEqual(after.generation, before.generation);
      const receipt = await f.receipt(id, operationId);
      assert.equal(receipt.id, operationId);
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.refusal, 'query_restarted');
      assert.equal(model.count, requestsBefore, 'a refused restart must send zero compaction model requests');
      const rows = await f.timeline(id);
      assert.equal(rows.filter(entry => entry.item.type === 'user_message' && entry.item.clientMessageId === operationId).length, 1,
        'exactly one /compact command must be sent');
      assert.equal(boundaries(rows).length, 0, 'no completed compaction boundary may exist');
      // Verify the same durable refusal receipt finishes the operation on restart reconciliation without resending.
      const statePath = join(f.home, 'plugin-data/auto-compact-for-claude/state.json');
      await f.client.disablePlugin('auto-compact-for-claude');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const stored = state.operations.find(entry => entry.id === operationId);
      assert(stored?.evidence?.dispatchStartedAt, 'dispatch marker must be persisted');
      stored.state = 'observing';
      stored.result = null;
      await writeFile(statePath, JSON.stringify(state));
      assert.equal((await f.client.enablePlugin('auto-compact-for-claude')).status, 'running');
      const recovered = await waitFor(async () => {
        const current = (await f.rpc('operation', { operationId })).operation;
        return current && ['succeeded', 'failed', 'unknown'].includes(current.state) ? current : null;
      }, 'reconciled query-restart refusal after plugin restart');
      assert.equal(recovered.state, 'failed', JSON.stringify(recovered));
      assert.equal(recovered.result?.code, 'failed_after_dispatch', JSON.stringify(recovered));
      assert.match(recovered.result?.message ?? '', /query restarted/i, JSON.stringify(recovered));
      assert.equal(model.count, requestsBefore, 'reconciliation must not send compaction requests');
      assert.equal((await f.timeline(id)).filter(entry => entry.item.type === 'user_message' && entry.item.clientMessageId === operationId).length, 1,
        'reconciliation must not resend /compact');
      await f.rpc('toggle', { agentId: id, enabled: false });
    },
  },
  {
    name: 'an automatic reservation right after a pending thinking-level change fails promptly as a query restart',
    async run({ fixture: f, model }) {
      await f.settings({ idleMinutes: 1 });
      const id = await f.agent();
      try {
        await f.client.setAgentThinkingOption(id, 'low');
        await f.turn(id, 'EFFORT_AUTOMATIC: reply without tools.');
        await scheduled(f, id);
        const before = await f.ledger(id);
        await f.client.setAgentThinkingOption(id, 'high');
        const requestsBefore = model.count;
        const settled = await waitFor(async () => {
          const current = await f.row(id);
          const op = current.latestOperation;
          // The observer can record the refusal before Paseo finishes closing the /compact turn.
          return op?.kind === 'automatic' && ['succeeded', 'failed', 'unknown'].includes(op.state) && current.status !== 'busy'
            ? { row: current, op } : null;
        }, 'prompt query-restart refusal for automatic reservation', 100_000);
        assert.equal(settled.row.status, 'failed', JSON.stringify(settled));
        assert.equal(settled.op.state, 'failed', JSON.stringify(settled));
        assert.equal(settled.op.result?.code, 'failed_after_dispatch', JSON.stringify(settled));
        assert.match(settled.op.result?.message ?? '', /query restarted/i, JSON.stringify(settled));
        const after = await f.ledger(id);
        assert.equal(after.launchId, before.launchId);
        assert.notEqual(after.generation, before.generation);
        const receipt = await f.receipt(id, settled.op.id);
        assert.equal(receipt.id, settled.op.id);
        assert.equal(receipt.status, 'failed');
        assert.equal(receipt.refusal, 'query_restarted');
        assert.equal(model.count, requestsBefore, 'a refused restart must send zero compaction model requests');
        const rows = await f.timeline(id);
        assert.equal(rows.filter(entry => entry.item.type === 'user_message' && entry.item.clientMessageId === settled.op.id).length, 1,
          'exactly one /compact command must be sent');
        assert.equal(boundaries(rows).length, 0, 'no completed compaction boundary may exist');
      } finally {
        await f.rpc('toggle', { agentId: id, enabled: false });
        await f.settings({ idleMinutes: 50 });
      }
    },
  },
  {
    name: 'daemon restart preserves OFF; reopening the same conversation permits a fresh reservation',
    async run({ fixture: f, model, id, sessionId }) {
      const settings = await f.settings(), requests = model.count;
      await f.restart();
      assert.deepEqual(await f.settings(), settings);
      assert.equal(model.count, requests, 'daemon restart must not send historical work');
      await f.client.refreshAgent(id);
      const recovered = await waitFor(() => f.row(id), 'reopened conversation metadata');
      assert.equal(recovered.enabled, false);
      assert.equal(model.count, requests, 'reopening without a prompt must not call the model');
      await f.rpc('toggle', { agentId: id, enabled: true });
      await f.turn(id, 'AFTER_RESTART: reply without tools.');
      await scheduled(f, id, 'transcript');
      assert.equal((await f.refresh(id)).persistence.sessionId, sessionId);
      const { config } = await f.client.getDaemonConfig();
      assert.deepEqual((config.agents?.providers ?? config.providers).claude.command, [f.binary]);
    },
  },
];
