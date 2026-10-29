// End-to-end check of the published install path. Runs on Linux and Windows with the same code.
// Real: an isolated Paseo daemon, `paseo plugin install/update` from GitHub, native Claude Code, the
// installed plugin's timers, RPCs, state and observer receipts. Simulated: model responses only
// (tests/simulation/model.mjs); other Claude traffic goes to a refusing proxy. See README.md.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startFixture, waitFor } from '../simulation/fixture.mjs';
import { startModel } from '../simulation/model.mjs';
import { scenarios } from '../simulation/scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const simulation = resolve(here, '../simulation');
const PLUGIN = 'auto-compact-for-claude';
const options = new Map([['--paseo', '0.13.0'], ['--from', 'v1.0.2'], ['--to', 'main'],
  ['--source', 'git:babo-jeonguk/paseo-auto-compact-for-claude'], ['--expect-platform', process.platform],
  ['--claude', process.env.SIMULATION_CLAUDE_BINARY ?? ''], ['--tools', simulation],
  ['--report-dir', join(resolve(here, '../..'), 'test-results', 'e2e')], ['--min', '0']]);
if (process.argv.includes('--help')) {
  console.log(`node --no-maglev tests/e2e/run.mjs ${[...options].map(([k, v]) => `[${k} ${v || '<path>'}]`).join(' ')}`);
  process.exit(0);
}
for (let i = 2; i < process.argv.length; i += 2) {
  assert(options.has(process.argv[i]), `Unknown option: ${process.argv[i]}`);
  assert(process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--'), `Missing value: ${process.argv[i]}`);
  options.set(process.argv[i], process.argv[i + 1]);
}
const arg = name => options.get(name);
const [FROM, TO, SOURCE, PASEO] = [arg('--from'), arg('--to'), arg('--source'), arg('--paseo')];
// These wait for real one-minute deadlines; --min 1 leaves them to the native matrix.
const LONG = ['real automatic timer', 'overdue reservation'];
const selected = arg('--min') === '1' ? scenarios.filter(s => !LONG.some(name => s.name.includes(name))) : scenarios;

const reportDir = join(resolve(arg('--report-dir')), `${process.platform}-paseo-${PASEO}`);
await mkdir(reportDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'Auto Compact e2e 한글 '));
const report = { startedAt: new Date().toISOString(), result: 'running', platform: process.platform, arch: process.arch,
  osRelease: release(), node: process.version, from: FROM, to: TO, source: SOURCE, revisions: {}, checks: [],
  model: 'synthetic-loopback; no paid model requests', root };
const checks = [];
const check = (name, run) => checks.push({ name, run });
let fixture, model, proxy, context, stopped = false;
const stop = async () => {
  if (stopped) return; stopped = true;
  await model?.close(); await fixture?.close();
  if (proxy?.listening) { proxy.closeAllConnections?.(); await new Promise(done => proxy.close(done)); }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.result = 'interrupted'; report.error = signal; void stop().finally(() => { process.exitCode = 1; });
});

// ---- helpers --------------------------------------------------------------------------------------
const statePath = () => join(fixture.home, 'plugin-data', PLUGIN, 'state.json');
const readState = async () => JSON.parse(await readFile(statePath(), 'utf8'));
const plugin = async () => {
  const listed = JSON.parse(await fixture.paseo('plugin', 'ls', PLUGIN, '--json'));
  return Array.isArray(listed) ? listed.find(p => p.id === PLUGIN) ?? listed[0] : listed;
};
const revisionOf = info => info?.installation?.currentRevision ?? info?.commit ?? info?.revision ?? '';
const remoteRevision = async ref => {
  if (!SOURCE.startsWith('git:')) return null;
  const url = `https://github.com/${SOURCE.slice(4)}.git`;
  const { stdout } = await promisify(execFile)('git', ['ls-remote', url, ref, `${ref}^{}`], { windowsHide: true, timeout: 60_000, cwd: tmpdir() });
  const rows = stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t'));
  return (rows.find(([, name]) => name.endsWith('^{}')) ?? rows[0])?.[0] ?? null;
};
async function moveTo(ref, key) {
  const before = revisionOf(await plugin());
  const output = await fixture.paseo('plugin', 'update', PLUGIN, '--ref', ref, '--yes');
  const info = await waitFor(async () => {
    const current = await plugin();
    return current.status === 'running' && revisionOf(current) !== before ? current : null;
  }, `plugin running at ${ref}`, 120_000);
  report.revisions[key] = revisionOf(info);
  const expected = await remoteRevision(ref);
  if (expected) assert.equal(report.revisions[key], expected, `installed revision for ${ref}`);
  return output;
}
// The plugin's own stderr: its console.error reports and Paseo's load/hook failures for it.
const pluginLog = async () => (await Promise.all([1, 2, 3, 4].map(n =>
  readFile(join(reportDir, `daemon-${n}.log`), 'utf8').catch(() => '')))).join('\n')
  .split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
  .filter(entry => entry.pluginId === PLUGIN && entry.stream === 'stderr').map(entry => String(entry.message));
// The fixture stops a daemon by signalling its whole process group, so the plugin can exit before
// Paseo delivers agent.closed during that shutdown. That is the harness, not the plugin.
const shutdownNoise = line => /^Lifecycle hook agent\.closed failed: Plugin process exited/.test(line);

// ---- 1. install the release a user has ------------------------------------------------------------
const legacy = {};
check(`install ${FROM} from GitHub with paseo plugin install`, async () => {
  const info = await plugin();
  assert.equal(info.status, 'running', JSON.stringify(info));
  report.revisions.from = revisionOf(info);
  const expected = await remoteRevision(FROM);
  if (expected) assert.equal(report.revisions.from, expected, `installed revision for ${FROM}`);
  assert.deepEqual((await fixture.rpc('list')).rows, []);
  assert.equal((await fixture.settings()).enabled, true);
});

// ---- 2. data the older release writes ------------------------------------------------------------
check(`${FROM} records a reservation, a conversation OFF and a completed Compact now`, async () => {
  for (const key of ['reserved', 'off', 'compacted']) {
    legacy[key] = await fixture.agent();
    await fixture.turn(legacy[key], `LEGACY_${key.toUpperCase()}: reply without tools.`);
  }
  legacy.row = await waitFor(async () => { const row = await fixture.row(legacy.reserved);
    return row.status === 'scheduled' && row.dueAt ? row : null; }, `${FROM} reservation`);
  assert((await fixture.rpc('toggle', { agentId: legacy.off, enabled: false })).changed);
  const ready = await waitFor(async () => { const row = await fixture.row(legacy.compacted);
    return row.status === 'scheduled' ? row : null; }, `${FROM} compactable row`);
  const requests = model.count;
  const result = await fixture.rpc('now', { agentId: legacy.compacted, revision: ready.revision });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(model.count, requests + 1);
  const state = await readState();
  assert.equal(state.version, 1);
  assert(state.disabled.includes(legacy.off));
  legacy.requests = model.count;
});

// ---- 3. update to the version under test -----------------------------------------------------------
check(`update to ${TO} adds operation history to state v1 and keeps policy, reservation and history`, async () => {
  await moveTo(TO, 'to');
  const state = await waitFor(async () => { const s = await readState(); return Array.isArray(s.operations) ? s : null; }, 'operation history');
  assert.equal(state.version, 1, 'additive fields keep the version the release reads');
  assert.equal((await fixture.row(legacy.off)).enabled, false, 'conversation OFF survives');
  const reserved = await fixture.row(legacy.reserved);
  assert.equal(reserved.status, 'scheduled'); assert.equal(reserved.dueAt, legacy.row.dueAt, 'reservation time survives');
  const compacted = await fixture.row(legacy.compacted);
  assert.equal(compacted.status, 'completed');
  assert.equal(compacted.latestOperation?.state, 'succeeded');
  assert.equal(compacted.latestOperation?.result?.code, 'legacy_outcome');
  assert.equal(compacted.latestOperation?.kind, 'legacy');
  assert.equal(state.operations.length, 1);
  const again = await fixture.rpc('now', { agentId: legacy.compacted, revision: compacted.revision,
    target: compacted.target, operationId: randomUUID() });
  assert.equal(again.code, 'existing', `the migrated attempt guards the same activity: ${again.detail}`);
  assert.equal(model.count, legacy.requests, 'update and migration send nothing');
  // An activity this release compacts, for the rollback to check.
  legacy.fresh = await fixture.agent();
  await fixture.turn(legacy.fresh, 'FRESH: reply without tools.');
  const fresh = await waitFor(async () => { const row = await fixture.row(legacy.fresh);
    return row.status === 'scheduled' ? row : null; }, `${TO} compactable row`);
  const beforeCompact = model.count;
  const accepted = await fixture.rpc('now', { agentId: legacy.fresh, revision: fresh.revision,
    target: fresh.target, operationId: randomUUID() });
  assert.equal(accepted.code, 'accepted', accepted.detail);
  await waitFor(async () => (await fixture.row(legacy.fresh)).latestOperation?.state === 'succeeded', `${TO} Compact now`);
  assert.equal(model.count, beforeCompact + 1, 'Compact now sends one request');
  legacy.requests = model.count;
  // Leave later scenarios a quiet host: their one-minute timers would otherwise also reach these.
  for (const id of Object.values(legacy).filter(v => typeof v === 'string'))
    await fixture.rpc('toggle', { agentId: id, enabled: false });
});

// ---- 4. main features on the updated install --------------------------------------------------------
for (const scenario of selected) check(scenario.name, () => scenario.run(context));

// ---- 5. rollback and roll forward ----------------------------------------------------------------
check(`rollback to ${FROM} keeps working on this state and sees what was compacted`, async () => {
  // Scenario reservations could legitimately fall due during the rollback; keep the host quiet.
  await fixture.settings({ enabled: false });
  const requests = model.count;
  await moveTo(FROM, 'rollback');
  await waitFor(async () => (await fixture.rpc('list').catch(() => null))?.rows, `${FROM} reads the state`);
  // The daemon restart scenario left these conversations unopened; open them like a user would.
  const row = async id => { await fixture.client.refreshAgent(id); return waitFor(() => fixture.row(id), `${FROM} row ${id}`); };
  assert.equal((await row(legacy.off)).enabled, false, 'conversation OFF survives rollback');
  // A finished job status is what keeps the release's timer from compacting an activity again.
  for (const id of [legacy.compacted, legacy.fresh])
    assert.equal((await row(id)).status, 'completed', `${FROM} sees the earlier compaction of ${id}`);
  assert.equal(model.count, requests, `${FROM} sends nothing`);
});
check(`updating to ${TO} again restores operation without replay`, async () => {
  const requests = model.count;
  await moveTo(TO, 'forward');
  await waitFor(async () => (await fixture.rpc('list').catch(() => null))?.rows, 'list after roll forward');
  assert((await readState()).disabled.includes(legacy.off), 'conversation OFF survives rollback');
  // The daemon restart scenario left this conversation unopened; open it like a user would.
  await fixture.client.refreshAgent(legacy.off);
  assert.equal((await waitFor(() => fixture.row(legacy.off), 'reopened OFF conversation')).enabled, false);
  // The rollback dropped operation history; it comes back from the jobs as legacy history, and
  // the finished job keeps the timer from compacting that activity again. (A manual guard needs the
  // native activity identity, which this unopened conversation does not report.)
  const fresh = await fixture.row(legacy.fresh);
  assert.equal(fresh.latestOperation?.kind, 'legacy');
  assert.equal(fresh.latestOperation?.state, 'succeeded');
  assert.equal(fresh.status, 'completed');
  assert.equal(model.count, requests);
  await fixture.settings({ enabled: true });
});

// ---- 6. daemon log ------------------------------------------------------------------------------
check('daemon log has no plugin errors', async () => {
  const lines = await pluginLog();
  const unexpected = lines.filter(line => !shutdownNoise(line));
  report.pluginErrorLines = lines.slice(0, 40);
  assert.deepEqual(unexpected, []);
});

// ---- run ----------------------------------------------------------------------------------------
try {
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or later');
  assert.equal(process.platform, arg('--expect-platform'), 'Native OS mismatch: run this using that OS\'s Node executable');
  const tools = createRequire(join(resolve(arg('--tools')), 'package.json'));
  const cliPackage = tools.resolve(`@getpaseo/cli-${PASEO.split('.').slice(0, 2).join('-')}/package.json`);
  report.paseo = JSON.parse(await readFile(cliPackage, 'utf8')).version;
  assert.equal(report.paseo, PASEO);
  let binary = arg('--claude');
  if (!binary) binary = join(dirname(tools.resolve(`@anthropic-ai/claude-code-${process.platform}-${process.arch}/package.json`)),
    process.platform === 'win32' ? 'claude.exe' : 'claude');
  await access(binary);
  report.claude = (await promisify(execFile)(binary, ['--version'], { timeout: 30_000, windowsHide: true })).stdout.trim();
  report.git = (await promisify(execFile)('git', ['--version'], { windowsHide: true })).stdout.trim();
  console.log(`E2E ${process.platform}/${process.arch}; Node ${process.version}; Paseo ${report.paseo}; Claude ${report.claude}; ${FROM} -> ${TO}`);

  report.blocked = [];
  proxy = createServer((req, res) => { report.blocked.push(`HTTP ${req.method} ${req.headers.host}`); res.writeHead(502).end(); });
  proxy.on('connect', (req, socket) => { report.blocked.push(`CONNECT ${req.url}`); socket.end('HTTP/1.1 502 Blocked\r\n\r\n'); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  model = await startModel();
  // A busy host can take minutes to start a daemon worker; the sibling plugins' E2E allows the same.
  fixture = await startFixture({ root, plugin: null, cliPackage, appVersion: report.paseo, binary, model, reportDir,
    readyTimeoutMs: 240_000,
    providerEnv: { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    install: async f => { await f.paseo('plugin', 'install', SOURCE, '--ref', FROM, '--json'); } });
  context = { fixture, model };
  for (const { name, run } of checks) {
    const started = Date.now();
    console.log(`RUN  ${name}`);
    try {
      await run();
      report.checks.push({ name, result: 'passed', durationMs: Date.now() - started });
      console.log(`PASS ${name}`);
    } catch (error) {
      report.checks.push({ name, result: 'failed', durationMs: Date.now() - started, error: String(error.stack ?? error) });
      throw error;
    }
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error.stack ?? error);
  console.error(report.error); process.exitCode = 1;
} finally {
  report.requests = model?.count ?? 0;
  await stop().catch(error => { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; });
  if (report.result === 'passed') {
    try { await fixture.remove(); delete report.root; }
    catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  report.checks.push(...checks.slice(report.checks.length).map(({ name }) => ({ name, result: 'not-run' })));
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.result.toUpperCase()}: ${report.checks.filter(c => c.result === 'passed').length}/${checks.length}; ` +
    `${report.requests} synthetic model requests; ${report.blocked?.length ?? 0} refused connections; ${join(reportDir, 'report.json')}`);
}
