// Real Paseo + native Claude + rendered web UI; only model replies are synthetic.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, release } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFixture, waitFor } from './fixture.mjs';
import { startModel } from './model.mjs';
import { acquireNativeSlot } from './execution.mjs';

const here = dirname(fileURLToPath(import.meta.url)), plugin = resolve(here, '../..');
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const version = option('--paseo', '0.15.0-beta.1');
const minimalBuiltins = process.argv.includes('--minimal-builtins');
const suite = option('--suite', 'all');
assert(['all', 'restart', 'browser', 'recovery', 'graceful-recovery', 'completed', 'interrupted', 'forced-interrupted', 'hooks'].includes(suite),
  'Use --suite all|restart|browser|recovery|graceful-recovery|completed|interrupted|forced-interrupted|hooks');
const run = part => suite === 'all' || suite === part || suite === 'restart' && ['completed', 'interrupted', 'recovery', 'hooks'].includes(part) ||
  suite === 'graceful-recovery' && part === 'recovery' || suite === 'forced-interrupted' && part === 'interrupted';
const tools = createRequire(join(resolve(option('--tools', here)), 'package.json'));
const nativeTools = createRequire(join(here, 'package.json'));
const cliPackage = (() => {
  try { return tools.resolve('@getpaseo/cli/package.json'); }
  catch { return tools.resolve('@getpaseo/cli-0-15/package.json'); }
})();
assert.equal(JSON.parse(await readFile(cliPackage, 'utf8')).version, version);
const binary = join(dirname(nativeTools.resolve(`@anthropic-ai/claude-code-${process.platform}-${process.arch}/package.json`)),
  process.platform === 'win32' ? 'claude.exe' : 'claude');
const reportDir = resolve(option('--report-dir', join(plugin, 'test-results', `restart-reconnect-${version}`)));
await mkdir(reportDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'paseo-restart-reconnect-'));
const report = { version, suite, platform: process.platform, arch: process.arch, osRelease: release(), node: process.version, root,
  bundledPlugins: minimalBuiltins ? 'omitted by test-only loader; default bundled-plugin coexistence not tested' : 'stock defaults',
  startedAt: new Date().toISOString(), model: 'synthetic loopback only', sources: {}, checks: [] };
let model, fixture, browser, proxy, releaseSlot;
const scheduled = id => waitFor(async () => {
  const row = await fixture.row(id);
  return row?.status === 'scheduled' && row.dueAt ? row : null;
}, 'ordinary reply creates reservation');
const operation = async id => (await fixture.rpc('operation', { operationId: id })).operation;
const compactCommands = rows => rows.filter(e => e.item.type === 'user_message' && e.item.text === '/compact');
async function storedAgent(id) {
  const agents = join(fixture.home, 'agents');
  for (const dir of await readdir(agents, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    try { return JSON.parse(await readFile(join(agents, dir.name, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}
async function deliveredRequests(id) {
  const directory = join(fixture.home, 'agent-requests'), rows = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.json')) continue;
    const row = JSON.parse(await readFile(join(directory, file), 'utf8'));
    if (row.agentId === id) rows.push({ file, ...row });
  }
  return rows;
}
const check = async (name, fn) => {
  console.log(`RUN ${name}`);
  const started = Date.now(), entry = { name, result: 'running' };
  report.checks.push(entry);
  try { entry.evidence = await fn(); entry.result = 'passed'; console.log(`PASS ${name}`); }
  catch (error) { entry.result = 'failed'; entry.error = String(error.stack ?? error); throw error; }
  finally { entry.durationMs = Date.now() - started; }
};

// The browser stays on this URL. Cutting its sockets leaves the real daemon
// reachable by the test client, so the state can change while the screen is offline.
async function connectionProxy(target) {
  let online = true, disconnects = 0;
  const sockets = new Set(), tunnels = new Set();
  const [host, port] = target.split(':');
  const server = createServer((incoming, outgoing) => {
    if (!online) { outgoing.writeHead(503).end(); return; }
    const forward = request({ hostname: host, port, method: incoming.method, path: incoming.url,
      headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    forward.on('error', () => outgoing.destroy()); incoming.pipe(forward);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!online) { socket.destroy(); return; }
    const upstream = connect(Number(port), host, () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    tunnels.add(upstream); upstream.on('close', () => tunnels.delete(upstream));
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get disconnects() { return disconnects; },
    offline() { online = false; disconnects++; for (const socket of [...sockets, ...tunnels]) socket.destroy(); },
    online() { online = true; },
    async close() { for (const socket of [...sockets, ...tunnels]) socket.destroy(); await new Promise(done => server.close(done)); },
  };
}

try {
  releaseSlot = await acquireNativeSlot();
  if (run('interrupted') || run('recovery')) assert.equal(process.platform, 'linux',
    'This restart suite distinguishes Linux graceful shutdown and process-group SIGKILL; use --suite browser|hooks on other systems');
  report.claude = (await promisify(execFile)(binary, ['--version'], { timeout: 30_000 })).stdout.trim();
  for (const path of ['index.server.ts', 'server/lifecycle.ts', 'server/gateway.ts', 'server/operations.ts', 'server/observer.ts',
    'server/scheduler.ts', 'client/conversation.tsx', 'client/conversations.tsx', 'client/session-state.ts',
    'tests/simulation/restart-reconnect.mjs', 'tests/simulation/fixture.mjs', 'tests/simulation/model.mjs'])
    report.sources[path] = createHash('sha256').update(await readFile(join(plugin, path))).digest('hex');
  model = await startModel();
  if (minimalBuiltins) report.sources['tests/simulation/minimal-builtins-loader.mjs'] = createHash('sha256')
    .update(await readFile(join(here, 'minimal-builtins-loader.mjs'))).digest('hex');
  fixture = await startFixture({ root, plugin, cliPackage, appVersion: version, binary, model, reportDir,
    webUi: true, readyTimeoutMs: 240_000,
    daemonEnv: minimalBuiltins ? { NODE_OPTIONS: `--experimental-loader=${pathToFileURL(join(here, 'minimal-builtins-loader.mjs')).href}` } : {},
    recoverySettings: { resumeOnStartup: true, resumePrompt: 'RESTART_RECOVERY: reply without tools.' } });
  await fixture.settings({ idleMinutes: 55 });

  if (run('hooks')) await check('the beta host supplies addHook directly to an installed plugin', async () => {
    const probe = join(root, 'hook-probe'), eventsPath = join(probe, 'events.jsonl');
    await mkdir(probe);
    await writeFile(join(probe, 'paseo-plugin.json'), JSON.stringify({ id: 'compact-hook-probe',
      name: 'Auto Compact hook verification', requirements: { paseo: '>=0.15.0-beta.1' } }));
    await writeFile(join(probe, 'index.server.ts'), `
      import { appendFile } from 'node:fs/promises';
      export default function contribute(server) {
        const save = event => appendFile(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
        const stops = [server.addHook('agent.open.before', async ({ request }) => {
          await save({ name: 'agent.open.before', id: request.agentId, purpose: request.purpose });
          return { ...request, env: { ...request.env, AUTO_COMPACT_NEW_HOOK_PROBE: 'present' } };
        })];
        for (const name of ['agent.create.after', 'agent.turn.before', 'agent.turn.after', 'agent.close.after'])
          stops.push(server.addHook(name, async ({ agent }) => { await save({ name, id: agent.id }); }));
        return () => stops.forEach(stop => stop());
      }
    `);
    assert.equal((await fixture.client.installDirectoryPlugin(probe)).status, 'running');
    const id = await fixture.agent(); await fixture.turn(id, 'NEW_HOOK_API: reply without tools.');
    await scheduled(id);
    const events = await waitFor(async () => {
      const rows = (await readFile(eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(e => e.id === id);
      return ['agent.create.after', 'agent.open.before', 'agent.turn.before', 'agent.turn.after'].every(name => rows.some(e => e.name === name)) ? rows : null;
    }, 'new hook names receive real lifecycle events');
    await fixture.rpc('toggle', { agentId: id, enabled: false });
    // Removing the probe avoids changing the tested plugin's hook ownership on
    // later restarts. Its successful turn also proves env merging preserved the Mod.
    await fixture.client.removePlugin('compact-hook-probe');
    return { events, ordinaryReplyAndReservationObserved: true };
  });

  if (run('completed')) await check('completed compaction survives restart; repeating the same request sends nothing', async () => {
    const id = await fixture.agent(); await fixture.turn(id, 'COMPLETE_BASELINE: reply without tools.');
    const row = await scheduled(id), operationId = randomUUID();
    const input = { agentId: id, revision: row.revision, target: row.target, operationId };
    await fixture.rpc('now', input);
    await waitFor(async () => (await operation(operationId))?.state === 'succeeded', 'baseline compaction succeeds', 60_000);
    const receipt = await fixture.receipt(id, operationId), requests = model.count;
    const liveCommands = compactCommands(await fixture.timeline(id));
    assert.equal(liveCommands.length, 1); assert.equal(liveCommands[0].item.clientMessageId, operationId);
    await fixture.restart({ graceful: true });
    const same = await fixture.rpc('now', input);
    assert.equal(same.operation.state, 'succeeded');
    assert.equal(model.count, requests);
    const commands = compactCommands(await fixture.timeline(id));
    // Claude's persisted history need not retain Paseo's clientMessageId.
    assert.equal(commands.length, 1);
    assert.equal(receipt.status, 'completed');
    return { operation: same.operation, liveCommands, commands, receipt, extraModelRequests: model.count - requests };
  });

  for (const abrupt of run('interrupted') ? suite === 'forced-interrupted' ? [true] : [false, true] : []) await check(
    `${abrupt ? 'forced termination' : 'graceful restart'} during compaction: a new ordinary reply is not compact success and compact is not resent`, async () => {
      const id = await fixture.agent(); await fixture.turn(id, 'INTERRUPT_BASELINE: reply without tools.');
      const row = await scheduled(id), oldLedger = await fixture.ledger(id), operationId = randomUUID();
      const input = { agentId: id, revision: row.revision, target: row.target, operationId };
      const gate = model.holdNext();
      const accepted = await fixture.rpc('now', input); assert.equal(accepted.status, 'running');
      await waitFor(() => gate.requestId, 'native compaction reaches held model request');
      await waitFor(async () => {
        const state = JSON.parse(await readFile(join(fixture.home, 'plugin-data/auto-compact-for-claude/state.json'), 'utf8'));
        return state.operations.find(op => op.id === operationId)?.evidence?.dispatchStartedAt;
      }, 'dispatch recorded durably');
      const beforeRestartRequests = model.count;
      const beforeRestartAgent = await fixture.refresh(id);
      const diagnostics = report.checks.at(-1).evidence = { beforeRestartAgent, operationId, beforeRestartRequests,
        storedBefore: await storedAgent(id), deliveredBefore: await deliveredRequests(id) };
      assert.equal(compactCommands(await fixture.timeline(id)).length, 1);
      await fixture.restart({ abrupt, graceful: !abrupt, onStopped: async () => { diagnostics.storedAfterStop = await storedAgent(id); } });
      assert.equal(model.requests.find(request => request.id === gate.requestId)?.cancelled, true,
        'the original model response must actually have been interrupted');
      gate.release();
      // Recovery eligibility is persisted, and graceful native shutdown can
      // clear it while closing a running turn. Inspect the saved candidate;
      // an explicit new message exercises safety when no recovery is due.
      const recoveryExpected = diagnostics.storedAfterStop?.resumeOnStartup === true || diagnostics.storedAfterStop?.lastStatus === 'running';
      const recoveryText = recoveryExpected
        ? 'RESTART_RECOVERY: reply without tools.' : 'USER_AFTER_RESTART: reply without tools.';
      if (!recoveryExpected) await fixture.send(id, recoveryText);
      const resumed = await waitFor(async () => {
        const rows = await fixture.timeline(id), ledger = await fixture.ledger(id);
        const prompt = rows.findLast(e => e.item.type === 'user_message' && e.item.text === recoveryText);
        const answer = prompt && rows.find(e => e.item.type === 'assistant_message' && e.turnId === prompt.turnId);
        return answer && ledger.launchId !== oldLedger.launchId && ledger.ordinaryEndedAt &&
          !ledger.activeTurns.length ? { prompt, answer, ledger } : null;
      }, 'new launch completes the new ordinary reply', 90_000);
      assert.equal(resumed.ledger.sessionId, oldLedger.sessionId);
      assert.notEqual((await operation(operationId)).state, 'succeeded', 'ordinary recovery reply must not prove compact success');
      const repeated = await fixture.rpc('now', input);
      assert.equal(repeated.operation.id, operationId); assert.notEqual(repeated.operation.state, 'succeeded');
      const settled = await waitFor(async () => {
        const op = await operation(operationId);
        assert.notEqual(op?.state, 'succeeded', 'interrupted compaction must never become a success');
        return op && !['requested', 'dispatching', 'observing'].includes(op.state) ? op : null;
      }, 'interrupted operation reaches an honest final result', 200_000);
      const commands = compactCommands(await fixture.timeline(id));
      // An interrupted /compact is not necessarily retained in Claude history.
      // Check the durable request ledger as well as model work, rather than
      // assuming a missing history item proves it was never sent.
      assert(commands.length <= 1);
      const deliveredAfter = await deliveredRequests(id);
      const beforeFiles = new Set(diagnostics.deliveredBefore.map(row => row.file));
      // Startup recovery dispatches internally, without a public message-inbox
      // record. An explicit user message contributes exactly one new record.
      assert.equal(deliveredAfter.filter(row => !beforeFiles.has(row.file)).length, recoveryExpected ? 0 : 1,
        'the public inbox must contain no extra compact delivery');
      assert(diagnostics.deliveredBefore.every(before => deliveredAfter.some(after =>
        after.file === before.file && after.fingerprint === before.fingerprint)));
      assert.equal(model.count - beforeRestartRequests, 1, 'only the new ordinary reply may reach the model');
      const retry = await fixture.rpc('now', input);
      assert.equal(retry.operation.state, settled.state);
      assert.equal((await deliveredRequests(id)).length, deliveredAfter.length);
      assert.equal(model.count - beforeRestartRequests, 1);
      await fixture.rpc('toggle', { agentId: id, enabled: false });
      return { ...diagnostics, settled, deliveredAfter, recoveryExpected, recoveryText, originalLaunch: oldLedger.launchId, resumed, commands,
        recoveryModelRequests: model.count - beforeRestartRequests };
    });

  if (run('recovery')) await check(`ordinary running work is automatically resumed after ${suite === 'graceful-recovery' ? 'graceful shutdown' : 'forced daemon termination'}`, async () => {
    const id = await fixture.agent(), gate = model.holdNext();
    await fixture.send(id, 'ORDINARY_INTERRUPTED: reply without tools.');
    await waitFor(() => gate.requestId, 'ordinary model request is in flight');
    const before = await fixture.refresh(id); assert.equal(before.status, 'running');
    const old = await fixture.ledger(id), requests = model.count;
    const diagnostics = report.checks.at(-1).evidence = { before, storedBefore: await storedAgent(id) };
    await fixture.restart({ abrupt: suite !== 'graceful-recovery', graceful: suite === 'graceful-recovery',
      onStopped: async () => { diagnostics.storedAfterStop = await storedAgent(id); } }); gate.release();
    const row = await scheduled(id), rows = await fixture.timeline(id), ledger = await fixture.ledger(id);
    assert(rows.some(e => e.item.type === 'user_message' && e.item.text === 'RESTART_RECOVERY: reply without tools.'));
    assert.notEqual(ledger.launchId, old.launchId); assert.equal(ledger.sessionId, old.sessionId);
    assert.equal(model.count, requests + 1); assert.equal(compactCommands(rows).length, 0);
    await fixture.rpc('toggle', { agentId: id, enabled: false });
    return { row, oldLaunch: old.launchId, newLaunch: ledger.launchId, automaticRecoveryRequests: model.count - requests };
  });

  if (run('browser')) {
  const executablePath = option('--browser');
  assert(executablePath, 'Specify --browser /path/to/chromium for rendered reconnect tests');
  const loaded = await import(pathToFileURL(nativeTools.resolve('playwright-core')));
  const { chromium } = loaded.chromium ? loaded : loaded.default;
  browser = await chromium.launch({ headless: true, executablePath: resolve(executablePath), args: ['--no-sandbox'] });
  report.chromium = browser.version();
  proxy = await connectionProxy(fixture.target);
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  const id = await fixture.agent();
  await fixture.turn(id, 'BROWSER_BASELINE: reply without tools.');
  const baseline = await scheduled(id);
  await page.goto(proxy.url, { waitUntil: 'domcontentloaded' });
  await page.getByText('Auto Compact simulation', { exact: true }).first().click();
  await page.screenshot({ path: join(reportDir, 'initial-conversation.png') });
  await page.getByText(/^Compact in \d+[ms]$/).first().click();
  const panel = page.getByTestId(`compact-conversation-${id}`);
  await panel.waitFor();
  await page.evaluate(() => { window.__reconnectTestIdentity = 'same-document'; });
  await check('disconnect removes stale countdown; reconnect shows changed schedule without reloading the page', async () => {
    assert.match(await panel.innerText(), /Compact in \d+[ms]/);
    proxy.offline();
    await fixture.rpc('skip', { agentId: id, revision: baseline.revision });
    await waitFor(async () => !/Compact in \d+[ms]/.test(await panel.innerText()), 'stale countdown is removed', 35_000);
    assert.equal(await panel.getByRole('button', { name: 'Compact now', exact: true }).isDisabled(), true);
    const offline = await panel.innerText(); await page.screenshot({ path: join(reportDir, 'offline.png') });
    proxy.online();
    await panel.getByText('Undo skip', { exact: true }).waitFor({ timeout: 60_000 });
    assert.doesNotMatch(await panel.innerText(), /Compact in \d+[ms]/);
    assert.equal((await fixture.row(id)).status, 'skipped');
    assert.equal(await page.evaluate(() => window.__reconnectTestIdentity), 'same-document');
    await page.screenshot({ path: join(reportDir, 'schedule-reconnected.png') });
    const reconnected = await panel.innerText();
    await panel.getByRole('button', { name: 'Undo skip', exact: true }).click();
    await scheduled(id);
    return { offline, reconnected, disconnects: proxy.disconnects, sameDocument: true };
  });
  await check('compaction completing while disconnected replaces the old progress display after reconnect', async () => {
    await panel.getByText(/^Compact in \d+[ms]$/).waitFor();
    const gate = model.holdNext();
    await panel.getByRole('button', { name: 'Compact now', exact: true }).click();
    await panel.getByRole('button', { name: 'Confirm compact', exact: true }).click();
    await waitFor(() => gate.requestId, 'UI compaction reaches native Claude');
    await panel.getByText('Compacting…', { exact: true }).waitFor();
    const running = (await fixture.row(id)).activeOperation;
    assert(running?.id); proxy.offline(); gate.release();
    await waitFor(async () => (await operation(running.id))?.state === 'succeeded', 'disconnected compact completes', 60_000);
    proxy.online();
    await waitFor(async () => {
      const text = await panel.innerText();
      return /Last compaction: Compaction completed in the same Claude session/.test(text) && !/Compacting…|Compaction requested/.test(text) ? text : null;
    }, 'screen replaces progress with completed result', 60_000);
    assert.equal(await page.evaluate(() => window.__reconnectTestIdentity), 'same-document');
    const commands = compactCommands(await fixture.timeline(id)); assert.equal(commands.length, 1);
    assert.equal(commands[0].item.clientMessageId, running.id);
    await page.screenshot({ path: join(reportDir, 'completed-reconnected.png') });
    return { operation: await operation(running.id), commands, body: await panel.innerText(), sameDocument: true };
  });
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error.stack ?? error); console.error(report.error); process.exitCode = 1;
  if (browser) await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(reportDir, 'failure.png') }).catch(() => {});
  if (browser) report.failureBody = await browser.contexts()[0]?.pages()[0]?.locator('body').innerText().catch(() => null);
} finally {
  for (const fn of [() => browser?.close(), () => proxy?.close(), () => model?.close(),
    () => fixture?.close(), () => releaseSlot?.()]) {
    try { await fn(); } catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; }
  }
  report.requests = model?.requests; report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.result.toUpperCase()}: ${report.checks.filter(c => c.result === 'passed').length}/${report.checks.length}; ${reportDir}/report.json`);
}
