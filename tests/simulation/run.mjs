import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, mkdtemp, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.mjs';
import { startModel } from './model.mjs';
import { scenarios } from './scenarios.mjs';
import { acquireNativeSlot } from './execution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, '../..');
if (process.argv.includes('--help')) {
  console.log('npm run test:simulation:0.12 -- [--expect-platform linux|win32] [--claude /native/claude] [--tools /npm/prefix] [--report-dir /results]');
  process.exit(0);
}
const value = (name, fallback) => {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  if (!process.argv[at + 1] || process.argv[at + 1].startsWith('--')) throw new Error(`Missing value: ${name}`);
  return process.argv[at + 1];
};
const paseoRequested = value('--paseo', '0.12.0');
const paseoPackages = new Map([
  ['0.12.0', '@getpaseo/cli-0-12'],
  ['0.13.0', '@getpaseo/cli-0-13'],
  ['0.14.0', '@getpaseo/cli-0-14'],
]);
assert(paseoPackages.has(paseoRequested), `Unsupported Paseo simulation version: ${paseoRequested}`);
const reportRoot = resolve(value('--report-dir', join(plugin, 'test-results', `${process.platform}-${process.arch}`)));
const reportDir = join(reportRoot, `paseo-${paseoRequested}`);
const tools = resolve(value('--tools', process.env.SIMULATION_TOOLS ?? here));
await mkdir(reportDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'Auto Compact simulation 한글 '));
const report = { startedAt: new Date().toISOString(), result: 'running', platform: process.platform,
  arch: process.arch, osRelease: release(), node: process.version, checks: [],
  model: 'synthetic-loopback; no paid model requests', root, sourceFiles: {} };
report.revision = process.env.GITHUB_SHA ?? null;
const sha = value => createHash('sha256').update(value).digest('hex');
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
let fixture, model, context, releaseSlot;
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  await model?.close(); await fixture?.close();
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.result = 'interrupted'; report.error = signal;
  void stop().finally(() => { process.exitCode = 1; });
});
try {
  const accepted = new Set(['--paseo', '--expect-platform', '--claude', '--tools', '--report-dir']);
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(accepted.has(process.argv[i]), `Unknown simulation option: ${process.argv[i]}`);
    assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Missing value: ${process.argv[i]}`);
  }
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or later');
  const expected = value('--expect-platform', process.platform);
  assert.equal(process.platform, expected, 'Native OS mismatch: run this using that OS\'s Node executable');
  releaseSlot = await acquireNativeSlot();
  const requireTools = createRequire(join(tools, 'package.json'));
  const alias = paseoPackages.get(paseoRequested);
  let cliPackage;
  const resolveCli = () => {
    try { return requireTools.resolve(`${alias}/package.json`); }
    catch {
      const candidate = requireTools.resolve('@getpaseo/cli/package.json');
      const installed = requireTools(candidate).version;
      if (installed !== paseoRequested)
        throw new Error(`Simulation tools have Paseo ${installed}; expected ${paseoRequested}`);
      return candidate;
    }
  };
  try { cliPackage = resolveCli(); }
  catch {
    if (tools !== here) throw new Error('Simulation tools unavailable at --tools');
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Run npm ci --prefix tests/simulation first, or start using npm run test:simulation');
    console.log('Installing pinned simulation tools (first run)...');
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [npm, 'ci', '--prefix', here, '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit', windowsHide: true });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Tool installation exited ${code}`)));
    });
    cliPackage = resolveCli();
  }
  report.paseo = JSON.parse(await readFile(cliPackage, 'utf8')).version;
  assert.equal(report.paseo, paseoRequested, 'Resolved Paseo version does not match the requested version');
  report.appVersion = report.paseo;
  let binary = value('--claude', process.env.SIMULATION_CLAUDE_BINARY);
  if (!binary) {
    const vendor = `@anthropic-ai/claude-code-${process.platform}-${process.arch}`;
    const location = dirname(requireTools.resolve(`${vendor}/package.json`));
    binary = join(location, process.platform === 'win32' ? 'claude.exe' : 'claude');
  }
  binary = resolve(binary); await access(binary);
  report.claude = (await promisify(execFile)(binary, ['--version'], { timeout: 30_000, windowsHide: true })).stdout.trim();
  console.log(`Native ${process.platform}/${process.arch}; Node ${process.version}; Paseo ${report.paseo}; Claude ${report.claude}`);
  for (const path of ['index.server.ts', 'server/cache.ts', 'server/observer.ts', 'server/observer-source.mjs',
    'server/observer-assets.generated.ts', 'server/gateway.ts', 'server/scheduler.ts', 'shared/settings.ts',
    'server/model.ts', 'server/store.ts', 'server/operations.ts', 'server/retention.ts', 'server/deadline.ts', 'shared/rpc.ts', 'shared/providers.ts', 'paseo-plugin.json', 'package.json'])
    report.sourceFiles[path] = sha(await readFile(join(plugin, path)));
  report.simulationFiles = {};
  for (const path of ['matrix.mjs', 'run.mjs', 'execution.mjs', 'fixture.mjs', 'model.mjs', 'scenarios.mjs', 'package.json', 'package-lock.json'])
    report.simulationFiles[path] = sha(await readFile(join(here, path)));
  model = await startModel();
  fixture = await startFixture({ root, plugin, cliPackage, appVersion: report.appVersion,
    binary, model, reportDir });
  context = { fixture, model };
  for (const scenario of scenarios) {
    const started = Date.now();
    console.log(`RUN  ${scenario.name}`);
    try {
      await scenario.run(context);
      report.checks.push({ name: scenario.name, result: 'passed', durationMs: Date.now() - started });
      console.log(`PASS ${scenario.name}`);
    } catch (error) {
      report.checks.push({ name: scenario.name, result: 'failed', durationMs: Date.now() - started, error: String(error.stack ?? error) });
      throw error;
    }
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error.stack ?? error);
  if (fixture && context?.id) {
    try {
      report.failureState = { row: await fixture.row(context.id),
        lastAssistant: (await fixture.timeline(context.id)).findLast(e => e.item.type === 'assistant_message')?.item.text };
    } catch { /* The daemon may already be unavailable. Its log is retained. */ }
  }
  console.error(report.error); process.exitCode = 1;
} finally {
  report.requests = model?.requests ?? [];
  await stop().catch(error => { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; });
  if (releaseSlot && !report.cleanupError) await releaseSlot().catch(error => { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; });
  if (report.result === 'passed') {
    try { await fixture.remove(); delete report.root; }
    catch (error) { report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString();
  const notRun = scenarios.slice(report.checks.length).map(scenario => ({ name: scenario.name, result: 'not-run' }));
  report.checks.push(...notRun);
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const tests = report.checks.map(check => `<testcase name="${xml(check.name)}" time="${(check.durationMs ?? 0) / 1000}">${
    check.result === 'not-run' ? '<skipped/>' : check.result === 'failed' ? `<failure>${xml(check.error)}</failure>` : ''}</testcase>`).join('\n');
  const infrastructureFailure = report.result !== 'passed' && !report.checks.some(check => check.result === 'failed');
  await writeFile(join(reportDir, 'junit.xml'), `<testsuite name="Auto Compact ${process.platform}" tests="${report.checks.length + Number(infrastructureFailure)}" failures="${Number(report.result !== 'passed')}">\n${tests}\n${infrastructureFailure ? `<testcase name="setup or cleanup"><failure>${xml(report.error ?? report.cleanupError)}</failure></testcase>` : ''}\n</testsuite>\n`);
  console.log(`${report.result.toUpperCase()}: ${report.checks.filter(c => c.result === 'passed').length}/${scenarios.length}; ${join(reportDir, 'report.json')}`);
}
