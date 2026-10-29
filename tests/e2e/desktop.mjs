// Desktop app E2E. The released Paseo desktop app (Electron) starts its own daemon in an isolated
// home, so the plugin's server code runs on the app's Electron runtime. The plugin is installed from
// GitHub and driven in the app window through the Chrome DevTools protocol. Simulated: model
// responses only (tests/simulation/model.mjs); other Claude traffic goes to a refusing proxy.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, release } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFixture, waitFor } from '../simulation/fixture.mjs';
import { startModel } from '../simulation/model.mjs';
import { installedPlugin, parseOptions, pluginStderr as stderrOf, remoteRevision, revisionOf, SOURCE as DEFAULT_SOURCE } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const simulation = resolve(here, '../simulation');
const isWin = process.platform === 'win32';
const run = promisify(execFile);
const arg = parseOptions('desktop.mjs', [['--paseo', '0.13.0'], ['--to', 'main'], ['--app', ''],
  ['--source', DEFAULT_SOURCE], ['--expect-platform', process.platform],
  ['--claude', ''], ['--tools', simulation], ['--report-dir', join(resolve(here, '../..'), 'test-results', 'e2e')]],
  [['--app', 'the extracted Paseo desktop app of the same version']]);
const [TO, SOURCE, PASEO] = [arg('--to'), arg('--source'), arg('--paseo')];
const appDir = resolve(arg('--app'));
// The Linux launcher script is what users run; it chooses sandboxing and execs Paseo.bin.
const appExecutable = join(appDir, isWin ? 'Paseo.exe' : 'Paseo');

const reportDir = join(resolve(arg('--report-dir')), `desktop-${process.platform}-paseo-${PASEO}`);
await mkdir(reportDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'Auto Compact desktop 한글 '));
const report = { startedAt: new Date().toISOString(), result: 'running', platform: process.platform, arch: process.arch,
  osRelease: release(), node: process.version, to: TO, source: SOURCE, app: appDir, checks: [], appStartupRetries: [],
  model: 'synthetic-loopback; no paid model requests', root };
const checks = [];
const check = (name, fn) => checks.push({ name, run: fn });
let fixture, model, proxy, appProxy, playwright, desktop, stopped = false;

// ---- desktop app ----------------------------------------------------------------------------------
const freePort = () => new Promise(done => { const s = createNetServer().listen(0, '127.0.0.1', () => {
  const port = s.address().port; s.close(() => done(port)); }); });
const pidFile = () => join(fixture?.home ?? join(root, 'paseo'), 'paseo.pid');
const daemonInstance = async () => JSON.parse(await readFile(pidFile(), 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function killTree(pid) {
  if (!pid || !alive(pid)) return;
  if (isWin) {
    await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 15_000 }).catch(() => {});
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await waitFor(() => !alive(pid), 'process exit', 8_000).catch(() => {});
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  await waitFor(() => !alive(pid), `process ${pid} exit`, 15_000).catch(() => {});
}
async function executableOf(pid) {
  if (!isWin) return readlink(`/proc/${pid}/exe`);
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`], { windowsHide: true });
  return stdout.trim();
}
function createDesktop() {
  let app, browser, page, environment, logPath, launches = 0;
  async function openApp() {
    // The app reads PATH from an interactive login shell. Ubuntu's update-motd.sh then runs an
    // unquoted `touch $HOME/.motd_shown`, which splits this spaced home into stray files.
    // .hushlogin is the documented opt-out, and the script tests it with quotes.
    await writeFile(join(environment.HOME, '.hushlogin'), '');
    const cdp = await freePort();
    // The app checks for and downloads its own updates. Its Chromium network goes to a refusing
    // proxy so the version under test stays put; the daemon keeps direct access for the GitHub install.
    const env = { ...environment, PASEO_ELECTRON_USER_DATA_DIR: join(root, 'electron'),
      // English UI keeps Paseo's own strings stable for the selectors below.
      PASEO_ELECTRON_FLAGS: `--proxy-server=http://127.0.0.1:${appProxy.address().port} --proxy-bypass-list=localhost;127.0.0.1;[::1] --lang=en-US` };
    for (const name of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'USERNAME', 'COMPUTERNAME', 'SystemDrive'])
      if (process.env[name]) env[name] = process.env[name];
    const log = openSync(logPath.replace(/\.log$/, `-app-${++launches}.log`), 'w');
    try {
      // Playwright's _electron.launch adds --inspect, which the app's CLI passthrough rejects;
      // --remote-debugging-port is one of the switches it ignores.
      app = spawn(appExecutable, ['--no-sandbox', `--remote-debugging-port=${cdp}`], { env, stdio: ['ignore', log, log],
        cwd: root, detached: !isWin });
      app.unref();
    } finally { closeSync(log); }
    browser = await waitFor(() => playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdp}`), 'desktop app DevTools', 120_000);
    page = await waitFor(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('paseo://')),
      'desktop app window', 120_000);
    await page.waitForLoadState('domcontentloaded');
    await appReady();
  }
  // The app waits 30 seconds for the daemon it starts, then shows a startup error with Retry while
  // that daemon is still starting. A slow host reaches it; retry as a user would, and record it.
  async function appReady() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ready = page.getByText('New workspace', { exact: true }).first().waitFor({ timeout: 240_000 }).then(() => 'ready');
      const failed = page.getByText(/did not return a server id|Failed to start|failed to start/i).first()
        .waitFor({ timeout: 240_000 }).then(() => 'failed');
      const outcome = await Promise.race([ready, failed]);
      ready.catch(() => {}); failed.catch(() => {});
      if (outcome === 'ready') return;
      const message = (await page.locator('body').innerText()).split('\n').find(line => /server id|start/i.test(line));
      report.appStartupRetries.push({ launch: launches, attempt, message, at: new Date().toISOString() });
      await page.screenshot({ path: join(reportDir, `startup-error-${launches}-${attempt}.png`) }).catch(() => {});
      await page.getByText('Retry', { exact: true }).click();
    }
    throw new Error('The desktop app did not become ready after three retries');
  }
  // Closes the window the way a user does, so the app runs its own quit lifecycle; forced only as a fallback.
  async function closeApp() {
    const pid = app?.pid;
    await page?.evaluate(() => window.close()).catch(() => {});
    const graceful = pid ? await waitFor(() => !alive(pid), 'app quit after its window closed', 60_000).then(() => true, () => false) : true;
    await browser?.close().catch(() => {}); browser = page = undefined;
    await killTree(pid); app = undefined;
    return graceful;
  }
  // Also used when startup fails before the fixture owns the app.
  async function shutdown() {
    const daemon = await daemonInstance().catch(() => null);
    await closeApp();
    await killTree(daemon?.pid);
  }
  return {
    get page() { return page; }, openApp, closeApp, shutdown,
    async start(context) {
      ({ environment, logPath } = context);
      await openApp();
      return {
        get exitCode() { return null; },
        stop: shutdown,
      };
    },
  };
}
const shot = name => desktop.page.screenshot({ path: join(reportDir, `${name}.png`) });
const openConversation = async () => {
  await desktop.page.getByText('Auto Compact simulation', { exact: true }).first().click({ timeout: 60_000 });
};
const pluginStderr = () => stderrOf([join(fixture.home, 'daemon.log')]);

// ---- checks -------------------------------------------------------------------------------------
const state = {};
check('the desktop app starts its own daemon on its Electron runtime in an isolated home', async () => {
  const instance = await daemonInstance();
  assert.equal(instance.desktopManaged, true, JSON.stringify(instance));
  report.daemonExecutable = await executableOf(instance.pid);
  assert.match(report.daemonExecutable, isWin ? /Paseo\.exe$/i : /Paseo\.bin$/, 'daemon must run on the app runtime');
  assert(report.daemonExecutable.startsWith(appDir), `daemon runs from ${report.daemonExecutable}`);
  const status = JSON.parse(await fixture.paseo('daemon', 'status', '--json'));
  report.daemonVersion = JSON.stringify(status).match(/"daemonVersion":"([^"]+)"/)?.[1] ?? null;
  assert.equal(report.daemonVersion, PASEO, 'the desktop app must match the requested Paseo version');
});
check(`the plugin installs from GitHub at ${TO} into the desktop daemon`, async () => {
  const info = await installedPlugin(fixture);
  assert.equal(info.status, 'running', JSON.stringify(info));
  report.revision = revisionOf(info);
  const expected = await remoteRevision(SOURCE, TO);
  if (expected) assert.equal(report.revision, expected);
});
check('a conversation started by the desktop daemon loads the observer and earns a 55-minute reservation', async () => {
  state.id = await fixture.agent();
  await fixture.turn(state.id, 'DESKTOP_READY: reply without tools.');
  const row = await waitFor(async () => { const r = await fixture.row(state.id);
    return r.status === 'scheduled' && r.cache?.source === 'transcript' ? r : null; }, 'desktop reservation');
  assert(row.dueAt > Date.now() + 54 * 60_000 && row.dueAt < Date.now() + 56 * 60_000);
  state.sessionId = (await fixture.refresh(state.id)).persistence.sessionId;
});
check('Skip and Undo in the desktop window update the daemon', async () => {
  const { page } = desktop;
  await openConversation();
  await page.getByText('Compact in 55m', { exact: true }).first().click({ timeout: 60_000 });
  await page.getByText('Skip this time', { exact: true }).click();
  await page.getByText('Undo skip', { exact: true }).waitFor();
  assert.equal((await fixture.row(state.id)).status, 'skipped');
  await shot('skipped');
  await page.getByText('Undo skip', { exact: true }).click();
  await waitFor(async () => (await fixture.row(state.id)).status === 'scheduled', 'desktop undo');
});
check('confirmed Compact now in the desktop window compacts once in the same session', async () => {
  const { page } = desktop, requests = model.count;
  await page.getByText('Compact now', { exact: true }).click();
  await page.getByText('Confirm compact', { exact: true }).click();
  const row = await waitFor(async () => { const r = await fixture.row(state.id);
    return r.status === 'completed' && r.latestOperation?.state === 'succeeded' ? r : null; }, 'desktop compaction', 90_000);
  state.operation = row.latestOperation;
  assert.equal(model.count, requests + 1);
  assert.equal((await fixture.refresh(state.id)).persistence.sessionId, state.sessionId);
  const boundaries = (await fixture.timeline(state.id)).filter(e => e.item.type === 'compaction' && e.item.status === 'completed');
  assert.equal(boundaries.length, 1);
});
const lastResultVisible = async name => {
  const { page } = desktop;
  await openConversation();
  await page.getByText('Context manually compacted', { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByText('Compact on', { exact: true }).first().click({ timeout: 60_000 });
  await page.getByText(/^Last compaction:/).waitFor({ timeout: 60_000 });
  const body = await page.locator('body').innerText();
  assert.doesNotMatch(body, /Request status unconfirmed|compaction failed/i);
  await shot(name);
};
check('the desktop window shows the last compaction after reload', async () => {
  await desktop.page.reload({ waitUntil: 'domcontentloaded' });
  await lastResultVisible('after-reload');
});
check('closing the window quits the app and its daemon; reopening restores the last result without resending', async () => {
  const before = await daemonInstance(), requests = model.count;
  assert(await desktop.closeApp(), 'the app quits when its window closes');
  // Default desktop setting: a desktop-managed daemon stops with the app (keepRunningAfterQuit off).
  await waitFor(() => !alive(before.pid), 'desktop daemon stopping with the app', 60_000);
  await fixture.restart();
  const after = await daemonInstance();
  assert.notEqual(after.pid, before.pid); assert.equal(after.desktopManaged, true);
  await lastResultVisible('after-app-restart');
  assert.deepEqual((await fixture.rpc('operation', { operationId: state.operation.id })).operation, state.operation);
  assert.equal(model.count, requests, 'restarting the app and daemon sends nothing');
});
check('the app downloaded no update of itself', async () => {
  // electron-updater caches downloads under the user's cache directory.
  const cache = isWin ? join(root, 'user', 'AppData', 'Local') : join(root, 'user', '.cache');
  const entries = await readdir(cache, { recursive: true }).catch(() => []);
  report.appUpdateFiles = entries.filter(name => /getpaseodesktop-updater/.test(name) && /\.(exe|AppImage|deb|rpm|zip)$/i.test(name));
  assert.deepEqual(report.appUpdateFiles, []);
});
check('daemon log has no plugin errors', async () => {
  report.pluginErrorLines = await pluginStderr();
  assert.deepEqual(report.pluginErrorLines, []);
});

// ---- run ----------------------------------------------------------------------------------------
try {
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or later');
  assert.equal(process.platform, arg('--expect-platform'), 'Native OS mismatch: run this using that OS\'s Node executable');
  assert(isWin || process.env.DISPLAY || process.env.WAYLAND_DISPLAY, 'No display: run under xvfb-run on Linux (see README.md)');
  await access(appExecutable);
  const tools = createRequire(join(resolve(arg('--tools')), 'package.json'));
  const loaded = await import(pathToFileURL(tools.resolve('playwright-core')));
  playwright = loaded.chromium ? loaded : loaded.default;
  const cliPackage = tools.resolve(`@getpaseo/cli-${PASEO.split('.').slice(0, 2).join('-')}/package.json`);
  report.paseo = JSON.parse(await readFile(cliPackage, 'utf8')).version;
  assert.equal(report.paseo, PASEO);
  const runtime = JSON.parse((await run(join(appDir, isWin ? 'Paseo.exe' : 'Paseo.bin'), ['-e',
    'console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node }))'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60_000 })).stdout);
  report.electron = runtime.electron; report.electronNode = runtime.node;
  let binary = arg('--claude');
  if (!binary) binary = join(dirname(tools.resolve(`@anthropic-ai/claude-code-${process.platform}-${process.arch}/package.json`)),
    isWin ? 'claude.exe' : 'claude');
  await access(binary);
  report.claude = (await run(binary, ['--version'], { timeout: 30_000, windowsHide: true })).stdout.trim();
  report.playwright = JSON.parse(await readFile(tools.resolve('playwright-core/package.json'), 'utf8')).version;
  console.log(`Desktop E2E ${process.platform}/${process.arch}; Paseo ${PASEO} app (Electron ${report.electron}, Node ${report.electronNode}); Claude ${report.claude}; ${TO}`);

  const refusing = async list => {
    const server = createServer((req, res) => { list.push(`HTTP ${req.method} ${req.headers.host}`); res.writeHead(502).end(); });
    server.on('connect', (req, socket) => { list.push(`CONNECT ${req.url}`); socket.end('HTTP/1.1 502 Blocked\r\n\r\n'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return server;
  };
  report.blocked = []; report.appBlocked = [];
  proxy = await refusing(report.blocked);
  appProxy = await refusing(report.appBlocked);
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  model = await startModel();
  desktop = createDesktop();
  fixture = await startFixture({ root, plugin: null, cliPackage, appVersion: report.paseo, binary, model, reportDir,
    readyTimeoutMs: 240_000, launcher: desktop,
    providerEnv: { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    install: async f => { await f.paseo('plugin', 'install', SOURCE, '--ref', TO, '--json'); } });
  for (const { name, run: fn } of checks) {
    const started = Date.now();
    console.log(`RUN  ${name}`);
    try {
      await fn();
      report.checks.push({ name, result: 'passed', durationMs: Date.now() - started });
      console.log(`PASS ${name}`);
    } catch (error) {
      report.checks.push({ name, result: 'failed', durationMs: Date.now() - started, error: String(error.stack ?? error) });
      await desktop?.page?.screenshot({ path: join(reportDir, 'failure.png') }).catch(() => {});
      throw error;
    }
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error.stack ?? error);
  console.error(report.error); process.exitCode = 1;
} finally {
  report.requests = model?.count ?? 0;
  if (!stopped) {
    stopped = true;
    try {
      await model?.close(); await fixture?.close(); await desktop?.shutdown();
      for (const server of [proxy, appProxy]) if (server?.listening) await new Promise(done => server.close(done));
    } catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; }
  }
  if (report.result === 'passed') {
    try { await fixture.remove(); delete report.root; }
    catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  report.checks.push(...checks.slice(report.checks.length).map(({ name }) => ({ name, result: 'not-run' })));
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.result.toUpperCase()}: ${report.checks.filter(c => c.result === 'passed').length}/${checks.length}; ` +
    `${report.requests} synthetic model requests; ${report.blocked?.length ?? 0} refused Claude and ` +
    `${report.appBlocked?.length ?? 0} refused app connections; ${join(reportDir, 'report.json')}`);
}
