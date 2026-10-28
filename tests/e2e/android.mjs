// Android app E2E. The released Paseo Android app runs in a fresh emulator and connects by direct
// connection to an isolated daemon on this host, where the plugin is installed from GitHub. The
// plugin's client code then runs natively in the app (Hermes, React Native views) and is driven
// through uiautomator. Simulated: model responses only (tests/simulation/model.mjs); other Claude
// traffic goes to a refusing proxy.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startFixture, waitFor } from '../simulation/fixture.mjs';
import { startModel } from '../simulation/model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const simulation = resolve(here, '../simulation');
const PLUGIN = 'auto-compact-for-claude';
const PACKAGE = 'sh.paseo';
const run = promisify(execFile);
const options = new Map([['--paseo', '0.13.0'], ['--to', 'main'], ['--apk', ''],
  ['--source', 'git:babo-jeonguk/paseo-auto-compact-for-claude'],
  ['--sdk', process.env.ANDROID_HOME ?? join(homedir(), 'Android', 'Sdk')],
  ['--system-image', 'system-images;android-34;google_apis;x86_64'], ['--avd-home', join(tmpdir(), 'auto-compact-e2e-avd')],
  ['--port', '5584'], ['--claude', ''], ['--tools', simulation],
  ['--report-dir', join(resolve(here, '../..'), 'test-results', 'e2e')]]);
if (process.argv.includes('--help')) {
  console.log(`node --no-maglev tests/e2e/android.mjs --apk <paseo-v<version>-android.apk> ${[...options].filter(([k]) => k !== '--apk')
    .map(([k, v]) => `[${k} ${v || '<path>'}]`).join(' ')}`);
  process.exit(0);
}
for (let i = 2; i < process.argv.length; i += 2) {
  assert(options.has(process.argv[i]), `Unknown option: ${process.argv[i]}`);
  assert(process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--'), `Missing value: ${process.argv[i]}`);
  options.set(process.argv[i], process.argv[i + 1]);
}
const arg = name => options.get(name);
const [TO, SOURCE, PASEO] = [arg('--to'), arg('--source'), arg('--paseo')];
assert(arg('--apk'), 'Specify --apk with the Paseo Android APK of the same version (see README.md)');
const apk = resolve(arg('--apk')), sdk = resolve(arg('--sdk')), avdHome = resolve(arg('--avd-home'));
const serial = `emulator-${arg('--port')}`;
const AVD = 'auto-compact-e2e';

const reportDir = join(resolve(arg('--report-dir')), `android-paseo-${PASEO}`);
await mkdir(reportDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'Auto Compact android 한글 '));
const report = { startedAt: new Date().toISOString(), result: 'running', host: process.platform, arch: process.arch,
  osRelease: release(), node: process.version, to: TO, source: SOURCE, apk, checks: [], anrDismissed: 0,
  model: 'synthetic-loopback; no paid model requests', root };
const checks = [];
const check = (name, fn) => checks.push({ name, run: fn });
let fixture, model, proxy, emulator, stopped = false;

// ---- emulator and adb -------------------------------------------------------------------------
const tool = (...path) => join(sdk, ...path);
const androidEnv = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: avdHome };
const adb = async (args, timeout = 120_000) =>
  (await run(tool('platform-tools', 'adb'), ['-s', serial, ...args], { env: androidEnv, timeout, maxBuffer: 32 * 1024 * 1024 })).stdout;
const shell = (...args) => adb(['shell', ...args]);
async function bootEmulator() {
  await mkdir(avdHome, { recursive: true });
  const avds = (await run(tool('emulator', 'emulator'), ['-list-avds'], { env: androidEnv })).stdout.split(/\r?\n/);
  if (!avds.includes(AVD)) {
    const create = spawn(tool('cmdline-tools', 'latest', 'bin', 'avdmanager'),
      ['create', 'avd', '-n', AVD, '-k', arg('--system-image'), '-d', 'pixel_6', '--force'], { env: androidEnv });
    create.stdin.end('no\n'); await once(create, 'exit');
    const config = join(avdHome, `${AVD}.avd`, 'config.ini');
    await writeFile(config, (await readFile(config, 'utf8')).replace(/^hw\.ramSize=.*$/m, 'hw.ramSize=2048'));
  }
  const log = openSync(join(reportDir, 'emulator.log'), 'w');
  try {
    // A fresh data partition per run; two cores keep the emulator's own hang watchdog quieter on a busy host.
    emulator = spawn(tool('emulator', 'emulator'), ['-avd', AVD, '-port', arg('--port'), '-wipe-data', '-no-window',
      '-no-audio', '-no-snapshot', '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-cores', '2'],
      { env: androidEnv, stdio: ['ignore', log, log], detached: true });
  } finally { closeSync(log); }
  await waitFor(async () => {
    assert.equal(emulator.exitCode, null, 'emulator exited; see emulator.log');
    return (await shell('getprop', 'sys.boot_completed').catch(() => '')).trim() === '1';
  }, 'emulator boot', 600_000);
  report.android = (await shell('getprop', 'ro.build.version.release')).trim();
}
async function stopEmulator() {
  if (!emulator) return;
  await adb(['emu', 'kill'], 30_000).catch(() => {});
  await waitFor(() => emulator.exitCode !== null || emulator.signalCode !== null, 'emulator exit', 30_000).catch(() => {});
  try { process.kill(-emulator.pid, 'SIGKILL'); } catch {}
  emulator = undefined;
}

// ---- UI through uiautomator -------------------------------------------------------------------
const attribute = (node, name) => node.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
async function nodes() {
  const xml = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], 60_000).catch(() => '');
  return [...xml.matchAll(/<node [^>]*>/g)].map(([node]) => {
    const [x1, y1, x2, y2] = (attribute(node, 'bounds').match(/\d+/g) ?? []).map(Number);
    return { text: attribute(node, 'text').replace(/&amp;/g, '&'), desc: attribute(node, 'content-desc').replace(/&amp;/g, '&'),
      cls: attribute(node, 'class'), pkg: attribute(node, 'package'), x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  });
}
const matches = (node, label) => typeof label === 'function' ? label(node)
  : [node.text, node.desc].some(value => label instanceof RegExp ? label.test(value) : value === label);
// A busy emulator reports its own System UI as not responding; waiting is the safe answer.
async function find(label, what = String(label), timeout = 120_000) {
  return waitFor(async () => {
    const list = await nodes();
    const anr = list.find(n => /isn.t responding/.test(n.text)) && list.find(n => n.text === 'Wait');
    if (anr) { report.anrDismissed++; await shell('input', 'tap', String(anr.x), String(anr.y)); return null; }
    return list.find(n => matches(n, label)) ?? null;
  }, what, timeout);
}
const tap = async (label, what) => { const node = await find(label, what); await shell('input', 'tap', String(node.x), String(node.y)); };
// The field itself, not its visible label of the same name.
async function type(label, value) {
  await tap(node => node.cls === 'android.widget.EditText' && node.desc === label, `${label} field`);
  await shell('input', 'keyevent', 'KEYCODE_MOVE_END', ...Array(24).fill('KEYCODE_DEL'));
  await shell('input', 'text', value);
}
const shot = async name => writeFile(join(reportDir, `${name}.png`),
  (await run(tool('platform-tools', 'adb'), ['-s', serial, 'exec-out', 'screencap', '-p'],
    { env: androidEnv, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })).stdout);
const launch = () => shell('monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1');
// Reach the conversation from whatever the app shows: it may reopen it, show a new chat, or leave
// the drawer over an already selected conversation. Paseo 0.12 briefly restores the last
// conversation after a restart and then moves to a new chat, so require the view to hold.
// The drawer lists "New workspace" with "Schedules"; 0.12's home screen has "New workspace" alone.
// Never press Back: on the home screen it leaves the app. A selected conversation can take ten
// seconds to show its pill on the emulator, so wait before acting again.
const openConversation = () => { let since = 0, tries = 0, selectedAt = 0; return waitFor(async () => {
  const list = await nodes();
  if (list.length && !list.some(n => n.pkg === PACKAGE)) { await launch(); selectedAt = Date.now(); return null; }
  const label = value => list.some(n => n.text === value || n.desc === value);
  const drawer = label('New workspace') && label('Schedules');
  const pill = list.some(n => /^Compact (on|in \d+m)$/.test(n.text));
  if (pill && !drawer) { since ||= Date.now(); return Date.now() - since >= 8_000; }
  since = 0;
  if (!drawer && Date.now() - selectedAt < 30_000) return null;
  if (drawer) {
    const conversation = list.find(n => /^Auto Compact simulation/.test(n.desc) || n.text === 'Auto Compact simulation');
    // Alternate: select the conversation, and if the drawer stays over it, close the drawer.
    if (conversation && tries++ % 2 === 0) {
      await shell('input', 'tap', String(conversation.x), String(conversation.y));
      selectedAt = Date.now();
    } else {
      const close = list.find(n => /^Close (menu|sidebar)$/.test(n.desc));
      if (close) await shell('input', 'tap', String(close.x), String(close.y));
    }
    await new Promise(r => setTimeout(r, 3_000));
  } else {
    const menu = list.find(n => n.desc === 'Open menu');
    if (menu) await shell('input', 'tap', String(menu.x), String(menu.y));
  }
  return null;
}, 'the conversation with the plugin pill', 180_000); };
const remoteRevision = async ref => {
  if (!SOURCE.startsWith('git:')) return null;
  const { stdout } = await run('git', ['ls-remote', `https://github.com/${SOURCE.slice(4)}.git`, ref, `${ref}^{}`],
    { timeout: 60_000, cwd: tmpdir() });
  const rows = stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t'));
  return (rows.find(([, name]) => name.endsWith('^{}')) ?? rows[0])?.[0] ?? null;
};
const pluginStderr = async () => (await Promise.all([1, 2].map(n => readFile(join(reportDir, `daemon-${n}.log`), 'utf8').catch(() => ''))))
  .join('\n').split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
  .filter(entry => entry.pluginId === PLUGIN && entry.stream === 'stderr').map(entry => String(entry.message));

// ---- checks -------------------------------------------------------------------------------------
const state = {};
check(`the plugin installs from GitHub at ${TO} and a conversation earns a 55-minute reservation`, async () => {
  const listed = JSON.parse(await fixture.paseo('plugin', 'ls', PLUGIN, '--json'));
  const info = Array.isArray(listed) ? listed.find(p => p.id === PLUGIN) ?? listed[0] : listed;
  assert.equal(info.status, 'running', JSON.stringify(info));
  report.revision = info?.installation?.currentRevision ?? info?.commit ?? info?.revision ?? '';
  const expected = await remoteRevision(TO);
  if (expected) assert.equal(report.revision, expected);
  state.id = await fixture.agent();
  await fixture.turn(state.id, 'ANDROID_READY: reply without tools.');
  await waitFor(async () => (await fixture.row(state.id)).status === 'scheduled', 'reservation');
  state.sessionId = (await fixture.refresh(state.id)).persistence.sessionId;
});
check('the Android app installs and connects to the isolated daemon by direct connection', async () => {
  await bootEmulator();
  await adb(['install', '-r', apk], 1_200_000);
  report.appVersion = (await shell('dumpsys', 'package', PACKAGE)).match(/versionName=(\S+)/)?.[1] ?? null;
  assert.equal(report.appVersion, PASEO, 'the app must match the requested Paseo version');
  await shell('pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS').catch(() => {});
  // The device's 127.0.0.1:<port> reaches this host's daemon; the daemon sees a loopback client.
  const port = fixture.target.split(':').at(-1);
  await adb(['reverse', `tcp:${port}`, `tcp:${port}`]);
  await launch();
  await tap('Direct connection');
  await type('Host', '127.0.0.1');
  await type('Port', port);
  await tap('Connect');
  await find(/^Open menu$/, 'the connected app', 180_000);
  await openConversation();
  await shot('connected');
});
check('the plugin pill renders natively with the reservation', async () => {
  state.pill = (await find(/^Compact in \d+m$/, 'the plugin pill with its countdown', 120_000)).text;
  await shot('pill');
});
check('Skip and Undo in the native sheet update the daemon', async () => {
  await tap(/^Compact in \d+m$/, 'the plugin pill');
  await tap('Skip this time');
  await waitFor(async () => (await fixture.row(state.id)).status === 'skipped', 'skip on the daemon');
  await tap('Undo skip');
  await waitFor(async () => (await fixture.row(state.id)).status === 'scheduled', 'undo on the daemon');
  await shot('undone');
});
check('confirmed Compact now on the device compacts once with an operation ID made on the device', async () => {
  const requests = model.count;
  await tap('Compact now');
  await tap('Confirm compact');
  const row = await waitFor(async () => { const r = await fixture.row(state.id);
    return r.status === 'completed' && r.latestOperation?.state === 'succeeded' ? r : null; }, 'device compaction', 180_000);
  state.operation = row.latestOperation;
  assert.equal(state.operation.kind, 'manual');
  assert.match(state.operation.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(model.count, requests + 1);
  assert.equal((await fixture.refresh(state.id)).persistence.sessionId, state.sessionId);
  const boundaries = (await fixture.timeline(state.id)).filter(e => e.item.type === 'compaction' && e.item.status === 'completed');
  assert.equal(boundaries.length, 1);
});
check('the native sheet shows the last compaction', async () => {
  await find(/^Last compaction: /, 'the last compaction in the sheet', 120_000);
  await shot('completed');
});
check('force-stopping and reopening the app shows the last result and sends nothing', async () => {
  // Like the OS killing the app: its in-memory submission state is gone; the daemon's record remains.
  const requests = model.count;
  await shell('am', 'force-stop', PACKAGE);
  await launch();
  await find(/^Open menu$/, 'the reconnected app', 180_000);
  await openConversation();
  await tap(/^Compact (on|in \d+m)$/, 'the plugin pill after restart');
  await find(/^Last compaction: /, 'the last compaction after restart', 120_000);
  await shot('after-app-restart');
  assert.deepEqual((await fixture.rpc('operation', { operationId: state.operation.id })).operation, state.operation);
  assert.equal(model.count, requests);
});
check('daemon log has no plugin errors', async () => {
  report.pluginErrorLines = await pluginStderr();
  assert.deepEqual(report.pluginErrorLines, []);
});

// ---- run ----------------------------------------------------------------------------------------
try {
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or later');
  for (const path of [apk, tool('platform-tools', 'adb'), tool('emulator', 'emulator')]) await access(path);
  const tools = createRequire(join(resolve(arg('--tools')), 'package.json'));
  const cliPackage = tools.resolve(`@getpaseo/cli-${PASEO.split('.').slice(0, 2).join('-')}/package.json`);
  report.paseo = JSON.parse(await readFile(cliPackage, 'utf8')).version;
  assert.equal(report.paseo, PASEO);
  let binary = arg('--claude');
  if (!binary) binary = join(dirname(tools.resolve(`@anthropic-ai/claude-code-${process.platform}-${process.arch}/package.json`)),
    process.platform === 'win32' ? 'claude.exe' : 'claude');
  await access(binary);
  report.claude = (await run(binary, ['--version'], { timeout: 30_000 })).stdout.trim();
  report.emulatorVersion = (await run(tool('emulator', 'emulator'), ['-version'], { env: androidEnv })).stdout.split('\n')[0].trim();
  console.log(`Android E2E on ${process.platform}/${process.arch}; Paseo ${PASEO} app ${apk}; ${report.emulatorVersion}; Claude ${report.claude}; ${TO}`);

  report.blocked = [];
  proxy = createServer((req, res) => { report.blocked.push(`HTTP ${req.method} ${req.headers.host}`); res.writeHead(502).end(); });
  proxy.on('connect', (req, socket) => { report.blocked.push(`CONNECT ${req.url}`); socket.end('HTTP/1.1 502 Blocked\r\n\r\n'); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  model = await startModel();
  fixture = await startFixture({ root, plugin: null, cliPackage, appVersion: report.paseo, binary, model, reportDir,
    readyTimeoutMs: 240_000,
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
      if (emulator) await shot('failure').catch(() => {});
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
      await stopEmulator(); await model?.close(); await fixture?.close();
      if (proxy?.listening) await new Promise(done => proxy.close(done));
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
    `${report.requests} synthetic model requests; ${report.blocked?.length ?? 0} refused connections; ${join(reportDir, 'report.json')}`);
}
