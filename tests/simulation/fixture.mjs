import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { join, dirname, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export async function waitFor(fn, label, timeout = 45_000) {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try { const result = await fn(); if (result) return result; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

// `install` replaces the default checkout install, e.g. with a GitHub install through the CLI.
export async function startFixture({ root, plugin, cliPackage, appVersion, binary, model, reportDir, webUi = false,
  install, providerEnv: extraProviderEnv = {}, readyTimeoutMs = 90_000 }) {
  const requireTools = createRequire(cliPackage);
  const cliRoot = dirname(cliPackage);
  const { DaemonClient } = await import(pathToFileURL(requireTools.resolve('@getpaseo/client/internal/daemon-client')));
  const { readLocalCredentialForTarget } = await import(pathToFileURL(requireTools.resolve('@getpaseo/server/daemon-control')));
  const { WebSocket } = requireTools('ws');
  const home = join(root, 'paseo'), user = join(root, 'user'), claude = join(root, 'claude');
  for (const path of [home, user, claude, join(user, 'AppData/Roaming'), join(user, 'AppData/Local')])
    await mkdir(path, { recursive: true });
  const port = await new Promise((resolve, reject) => {
    const probe = createServer(); probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const target = `127.0.0.1:${port}`;
  // Do not inherit real API credentials, provider settings or daemon locations.
  // Windows needs its OS environment and PATH to launch native child processes.
  const environment = { HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData/Roaming'),
    LOCALAPPDATA: join(user, 'AppData/Local'), TMPDIR: root, TMP: root, TEMP: root,
    PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''),
    PASEO_HOME: home, PASEO_LISTEN: target, PASEO_RELAY_ENABLED: 'false' };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'OS',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'CLAUDE_CODE_GIT_BASH_PATH'])
    if (process.env[name]) environment[name] = process.env[name];
  const providerEnv = { ...environment, CLAUDE_CONFIG_DIR: claude,
    ANTHROPIC_API_KEY: 'synthetic-loopback-only', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: model.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_AUTO_COMPACT: '1', ...extraProviderEnv };
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, pluginsEnabled: true,
    daemon: { listen: target, relay: { enabled: false }, mcp: { enabled: false } },
    features: { dictation: { enabled: false }, voiceMode: { enabled: false }, webUi: { enabled: webUi } },
    agents: { providers: {
      claude: { command: [binary], env: providerEnv },
      'claude-env': { extends: 'claude', label: 'Simulation explicit TTL', env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } },
    } },
  }));
  let daemon, client, workspace, launchError, generation = 0;
  async function start() {
    launchError = undefined;
    const log = openSync(join(reportDir, `daemon-${++generation}.log`), 'w');
    try {
      daemon = spawn(process.execPath, ['--no-maglev', join(cliRoot, 'bin/paseo'),
        'daemon', 'run', '--home', home], { env: environment, stdio: ['ignore', log, log],
        detached: process.platform !== 'win32', windowsHide: true });
      daemon.on('error', error => { launchError = error; });
    } finally { closeSync(log); }
    const until = Date.now() + readyTimeoutMs;
    while (Date.now() < until) {
      if (launchError) throw launchError;
      assert.equal(daemon.exitCode, null, 'Isolated Paseo daemon exited; inspect daemon log');
      const candidate = new DaemonClient({ url: `ws://${target}/ws`, clientId: 'auto-compact-simulation',
        clientType: 'cli', appVersion, connectTimeoutMs: 1000, reconnect: { enabled: false },
        localCredential: async () => readLocalCredentialForTarget(home, target) ?? undefined,
        webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) });
      try { await candidate.connect(); client = candidate; return; }
      catch { await candidate.close().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    throw new Error('Isolated Paseo daemon did not become ready');
  }
  async function stop() {
    await client?.close().catch(() => {}); client = undefined;
    if (!daemon?.pid) return;
    const pid = daemon.pid;
    if (process.platform === 'win32') {
      await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }).catch(() => {});
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      await waitFor(() => daemon.exitCode !== null || daemon.signalCode !== null, 'test daemon shutdown', 4000).catch(() => {});
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
    daemon = undefined;
  }
  const fixture = {
    root, home, claude, binary, target, get client() { return client; },
    rpc: (name, input = {}) => client.invokePluginRpc('auto-compact-for-claude', `auto-compact.${name}`, input),
    // The real `paseo` CLI against this isolated daemon home.
    async paseo(...args) {
      const { stdout } = await promisify(execFile)(process.execPath, [join(cliRoot, 'bin/paseo'), ...args, '--home', home],
        { env: environment, timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    },
    async settings(values) {
      const current = await client.invokePluginRpc('auto-compact-for-claude', 'settings.automation.read', {});
      if (!values) return current.values;
      await client.invokePluginRpc('auto-compact-for-claude', 'settings.automation.write', {
        revision: current.revision, values: { ...current.values, ...values } });
      return { ...current.values, ...values };
    },
    async agent(provider = 'claude') {
      const result = await client.createAgent({ provider, cwd: root, workspaceId: workspace.id,
        model: 'claude-sonnet-4-6[1m]', modeId: 'default', title: 'Auto Compact simulation' });
      return result.id;
    },
    async row(id) { return (await fixture.rpc('session', { agentId: id })).row; },
    async send(id, text) { await client.sendMessage(id, text); },
    async turn(id, label) {
      const replies = await fixture.timeline(id);
      const seen = new Set(replies.filter(e => e.item.type === 'assistant_message').map(e => e.item.text));
      await fixture.send(id, label);
      // Public waitForFinish alone can report early when compaction overlaps input.
      return waitFor(async () => {
        const rows = await fixture.timeline(id);
        const own = rows.findLast(e => e.item.type === 'assistant_message' && !seen.has(e.item.text));
        const row = await fixture.row(id);
        return own && row.status !== 'busy' ? { text: own.item.text, row } : null;
      }, `native reply: ${label}`);
    },
    async timeline(id) { return (await client.fetchAgentTimeline(id, { limit: 200 })).entries; },
    async refresh(id) { return (await client.fetchAgent(id)).agent; },
    async ledger(id) {
      const parent = join(home, 'plugin-data/auto-compact-for-claude/observers',
        createHash('sha256').update(id).digest('hex'));
      const manifest = JSON.parse(await readFile(join(parent, 'current.json'), 'utf8'));
      return JSON.parse(await readFile(join(parent, manifest.launchId, 'ledger.json'), 'utf8'));
    },
    async receipt(id, operationId) {
      const parent = join(home, 'plugin-data/auto-compact-for-claude/observers',
        createHash('sha256').update(id).digest('hex'));
      return JSON.parse(await readFile(join(parent, 'receipts', `${encodeURIComponent(operationId)}.json`), 'utf8'));
    },
    async claudeSettings(values) { await writeFile(join(claude, 'settings.json'), JSON.stringify(values)); },
    async restart() { await stop(); await start(); },
    async close() { await stop(); },
    async remove() { await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 400 }); },
  };
  try {
    await start();
    if (install) await install(fixture);
    else assert.equal((await client.installDirectoryPlugin(plugin)).status, 'running');
    workspace = (await client.createWorkspace({ source: { kind: 'directory', path: root }, title: 'Auto Compact simulation' })).workspace;
    return fixture;
  } catch (error) { await stop(); throw error; }
}
