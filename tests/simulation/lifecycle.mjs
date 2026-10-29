import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { startFixture, waitFor } from './fixture.mjs';
import { startModel } from './model.mjs';
const here = dirname(fileURLToPath(import.meta.url)), plugin = resolve(here, '../..');
const require = createRequire(join(here, 'package.json'));
const cliPackage = require.resolve('@getpaseo/cli-0-14/package.json');
const binary = join(dirname(require.resolve(`@anthropic-ai/claude-code-${process.platform}-${process.arch}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude');
const root = await mkdtemp(join(tmpdir(), 'paseo-lifecycle-'));
const reportDir = join(root, 'logs'); await mkdir(reportDir);
const marker = join(root, 'cleanup');
const model = await startModel();
let f;
const scheduled = id => waitFor(async () => { const row = await f.row(id); return row.status === 'scheduled' && row.dueAt ? row : null; }, 'scheduled');
try {
 f = await startFixture({root, plugin, cliPackage, appVersion:'0.14.0', binary, model, reportDir, readyTimeoutMs:180_000,
   daemonEnv:process.argv[2] !== 'cleanup' ? {} : {NODE_OPTIONS:`--experimental-loader=${join(here,'lifecycle-loader.mjs')}`, LIFECYCLE_CLEANUP_MARKER:marker}});
 await f.settings({idleMinutes:50});
 if (process.argv[2] === 'reload') {
 const id = await f.agent(); await f.turn(id, 'RELOAD_READY: reply without tools.');
 const beforeRow = await scheduled(id), old = await f.ledger(id), session = (await f.refresh(id)).persistence.sessionId;
 const before = model.count, operationId = randomUUID();
 assert.equal((await f.client.reloadPlugin('auto-compact-for-claude')).status,'running');
 const afterReload = await f.ledger(id);
 const accepted = await f.rpc('now',{agentId:id, revision:beforeRow.revision, target:beforeRow.target, operationId});
 assert.equal(accepted.status, 'running');
 const blocked = await waitFor(async () => { const op = (await f.rpc('operation',{operationId})).operation; return op?.state === 'failed' ? op : null; }, 'reload operation fails before dispatch');
 const timeline = await f.timeline(id);
 let receipt = null; try { receipt = await f.receipt(id, operationId); } catch {}
 const unchanged = await f.ledger(id);
 console.log('reload refused', JSON.stringify({old,afterReload,unchanged,session,requestDelta:model.count-before,blocked,receipt,timeline}));
 assert.match(JSON.stringify(blocked.result), /Session must resume after plugin reload; send a message before compacting/);
 assert.equal(model.count,before); assert.equal(receipt,null);
 assert.equal(timeline.filter(e=>e.item.type==='user_message' && e.item.clientMessageId===operationId).length,0);
 assert.equal(timeline.filter(e=>e.item.type==='compaction').length,0);
 assert.equal(unchanged.launchId,old.launchId); assert.equal(unchanged.generation,old.generation);
 assert.equal((await f.refresh(id)).persistence.sessionId,session);
 const duplicate = await f.rpc('now',{agentId:id, revision:beforeRow.revision, target:beforeRow.target, operationId});
 assert.equal(duplicate.operation.state,'failed'); assert.equal(model.count,before);
 await f.turn(id,'AFTER_RELOAD: reply without tools.');
 const fresh = await scheduled(id), reopened = await f.ledger(id);
 assert.notEqual(reopened.launchId,old.launchId); assert.notEqual(reopened.generation,old.generation);
 assert.equal((await f.refresh(id)).persistence.sessionId,session);
 assert.equal(model.count,before+1);
 const nextId = randomUUID(), preCompact = model.count;
 const next = await f.rpc('now',{agentId:id, revision:fresh.revision, target:fresh.target, operationId:nextId});
 assert.equal(next.status,'running');
 const completed = await waitFor(async () => { const op = (await f.rpc('operation',{operationId:nextId})).operation; return op?.state === 'succeeded' ? op : null; }, 'fresh compact succeeds', 60000);
 const nextTimeline = await f.timeline(id), commands = nextTimeline.filter(e=>e.item.type==='user_message' && e.item.clientMessageId===nextId);
 const boundaries = nextTimeline.filter(e=>e.item.type==='compaction' && e.item.status==='completed');
 const nextReceipt = await f.receipt(id,nextId);
 console.log('reload recovery',JSON.stringify({fresh,reopened,completed,commands,boundaries,receipt:nextReceipt,requestDelta:model.count-preCompact}));
 assert.equal(model.count,preCompact+1); assert.equal(commands.length,1); assert(commands[0].turnId);
 assert.equal(boundaries.length,1); assert.equal(boundaries[0].turnId,commands[0].turnId);
 assert.equal(nextReceipt.id,nextId); assert.equal(nextReceipt.status,'completed');
 assert.equal(nextReceipt.launchId,reopened.launchId); assert.equal(nextReceipt.generation,reopened.generation);
 assert.equal(nextReceipt.sessionId,session); assert.equal((await f.refresh(id)).persistence.sessionId,session);
 const repeat = await f.rpc('now',{agentId:id, revision:fresh.revision, target:fresh.target, operationId:nextId});
 assert.equal(repeat.operation.state,'succeeded'); assert.equal(model.count,preCompact+1);
 await f.rpc('toggle',{agentId:id,enabled:false});
 }
 if (process.argv[2] === 'automatic') {
 await f.settings({idleMinutes:1});
 const id = await f.agent(); await f.turn(id,'AUTOMATIC_RELOAD_READY: reply without tools.');
 const reserved = await scheduled(id), old = await f.ledger(id), session = (await f.refresh(id)).persistence.sessionId;
 const before = model.count;
 assert(reserved.dueAt > Date.now(), 'reservation must still be due in the future');
 assert(reserved.dueAt < Date.now()+60_000);
 assert.equal((await f.client.reloadPlugin('auto-compact-for-claude')).status,'running');
 const unchanged = await f.ledger(id);
 assert.equal(unchanged.launchId,old.launchId); assert.equal(unchanged.generation,old.generation);
 // Reconnect the plugin's host via the public row RPC, as opening its UI does.
 await f.row(id);
 const statePath = join(f.home,'plugin-data/auto-compact-for-claude/state.json');
 const persisted = await waitFor(async () => {
   if (Date.now() < reserved.dueAt) return null;
   const state = JSON.parse(await readFile(statePath,'utf8'));
   const job = state.jobs.find(entry=>entry.agentId===id);
   return job?.status === 'blocked' && /Session must resume after plugin reload/.test(job.detail) ? {job,state} : null;
 }, 'automatic due tick blocks stale observer', 100_000);
 const row = await f.row(id), timeline = await f.timeline(id);
 const receiptDir = join(f.home,'plugin-data/auto-compact-for-claude/observers',createHash('sha256').update(id).digest('hex'),'receipts');
 const receipts = await readdir(receiptDir).catch(error=> { if (error.code === 'ENOENT') return []; throw error; });
 assert.equal(model.count,before); assert.equal(persisted.state.operations.filter(op=>op.agentId===id).length,0);
 assert.equal(timeline.filter(e=>e.item.type==='user_message' && e.item.text==='/compact').length,0);
 assert.equal(timeline.filter(e=>e.item.type==='compaction').length,0); assert.deepEqual(receipts,[]);
 assert.equal(row.status,'blocked'); assert.match(row.detail,/Session must resume after plugin reload/);
 console.log('automatic blocked', JSON.stringify({reserved,old,unchanged,job:persisted.job,row,requestDelta:model.count-before,receipts,timeline}));
 await f.turn(id,'AUTOMATIC_AFTER_RELOAD: reply without tools.');
 const fresh = await scheduled(id), reopened = await f.ledger(id);
 assert.notEqual(reopened.launchId,old.launchId); assert.notEqual(reopened.generation,old.generation);
 assert.equal((await f.refresh(id)).persistence.sessionId,session);
 assert.notEqual(fresh.revision,reserved.revision); assert.equal(model.count,before+1);
 console.log('automatic resumed',JSON.stringify({fresh,reopened,session,requestDelta:model.count-before}));
 await f.rpc('toggle',{agentId:id,enabled:false});
 }
 if (process.argv[2] === 'cleanup') {
 const cleanupId = await f.agent(); await f.turn(cleanupId,'CLEANUP_READY: reply without tools.');
 const reservation = await scheduled(cleanupId), oldCleanup = await f.ledger(cleanupId), cleanupSession = (await f.refresh(cleanupId)).persistence.sessionId;
 await writeFile(marker,'go');
 const closed = await waitFor(async () => { const l = await f.ledger(cleanupId); return l.closed ? l : null; }, 'cleanup observer closed', 15000);
 await rm(marker);
 const statePath = join(f.home, 'plugin-data/auto-compact-for-claude/state.json');
 const invalidated = await waitFor(async () => { const state = JSON.parse(await readFile(statePath, 'utf8')); const job = state.jobs.find(job => job.agentId === cleanupId); return job?.status === 'skipped' ? job : null; }, 'closed lifecycle invalidates reservation');
 const cleanupLog = await readFile(join(reportDir, 'daemon-1.log'), 'utf8');
 assert(cleanupLog.includes('Collected idle agent runtime'));
 const closedRow = await f.row(cleanupId); const closedAgent = await f.refresh(cleanupId);
 assert.equal(closedRow, null); assert.equal(closedAgent.status, 'closed'); assert.equal(invalidated.revision, reservation.revision); assert.equal(invalidated.detail, 'Activity or session state changed');
 console.log('cleanup closed', JSON.stringify({reservation,oldCleanup,closed,invalidated,closedRow,closedAgent}));
 const requests = model.count;
 await f.turn(cleanupId,'AFTER_CLEANUP: reply without tools.');
 const fresh = await scheduled(cleanupId), reopened = await f.ledger(cleanupId), reopenedAgent = await f.refresh(cleanupId);
 console.log('cleanup resumed', JSON.stringify({fresh,reopened,reopenedAgent,requestDelta:model.count-requests}));
 assert.notEqual(reopened.launchId,oldCleanup.launchId); assert.notEqual(reopened.generation,oldCleanup.generation); assert.equal(reopenedAgent.persistence.sessionId,cleanupSession);
 assert.notEqual(fresh.revision,reservation.revision); assert.equal(model.count,requests+1);
 }
 console.log('PASS lifecycle');
} finally { await f?.close(); await model.close(); console.log(`artifacts ${root}`); }
