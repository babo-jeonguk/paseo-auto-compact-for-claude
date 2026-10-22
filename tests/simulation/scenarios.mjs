import assert from 'node:assert/strict';
import { waitFor } from './fixture.mjs';

const scheduled = (f, id, source) => waitFor(async () => {
  const row = await f.row(id);
  return row.status === 'scheduled' && row.dueAt && (!source || row.cache?.source === source) ? row : null;
}, `scheduled reservation${source ? ` (${source})` : ''}`);
const boundaries = rows => rows.filter(row => row.item.type === 'compaction' && row.item.status === 'completed');

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
    name: 'batched background-agent notifications finish without phantom pending input',
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
      assert.equal((await f.rpc('now', { agentId: manualId, revision: tooSmall.revision })).status, 'completed');
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
      assert.equal((await f.rpc('now', { agentId: id, revision: row.revision })).status, 'completed');
      assert.equal((await f.refresh(id)).persistence.sessionId, sessionId);
    },
  },
  {
    name: 'input during compaction keeps its own reply and cannot be mistaken for compact success',
    async run({ fixture: f, model, id }) {
      await f.turn(id, 'RACE_READY: reply without tools.');
      const row = await scheduled(f, id);
      const compact = model.holdNext();
      const operation = f.rpc('now', { agentId: id, revision: row.revision });
      await waitFor(() => compact.requestId, 'in-flight compaction');
      const user = model.holdNext();
      await f.send(id, 'INPUT_DURING_COMPACT: reply without tools.');
      compact.release();
      await waitFor(() => user.requestId, 'overlapping user request');
      const result = await operation;
      // Claude can acknowledge cancellation before the overlapping input is
      // observed. A confirmed cancellation is failed; an uncertain outcome is
      // unknown. Neither may be promoted to successful compaction.
      assert(result.status === 'unknown' || (result.status === 'failed' &&
        /cancel|without completing|did not complete/i.test(result.detail)), JSON.stringify(result));
      assert.equal((await f.row(id)).status, 'busy');
      user.release();
      await waitFor(async () => (await f.timeline(id)).some(row => row.item.type === 'assistant_message' &&
        row.item.text.includes(`SIMULATION_REPLY_${user.requestId}`)), 'the user\'s own assistant reply');
      const fresh = await scheduled(f, id);
      assert.notEqual(fresh.revision, row.revision);
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
