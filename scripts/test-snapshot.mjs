import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = async (...args) => (await promisify(execFile)('git', ['-C', root, ...args], { windowsHide: true })).stdout.trim();
const options = new Map([['--suite', 'check'], ['--ref', 'HEAD'], ['--paseo', 'all']]);
if (process.argv.includes('--help')) {
  console.log('npm run test:snapshot -- [--suite check|simulation|release] [--ref HEAD|<commit>] [--paseo all|0.12.0|0.13.0|0.14.0]');
  process.exit(0);
}
for (let i = 2; i < process.argv.length; i += 2) {
  assert(options.has(process.argv[i]) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Invalid option: ${process.argv[i]}`);
  options.set(process.argv[i], process.argv[i + 1]);
}
const suite = options.get('--suite'), paseo = options.get('--paseo');
assert(['check', 'simulation', 'release'].includes(suite), `Unknown suite: ${suite}`);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const versionScript = `test:simulation:${paseo.split('.').slice(0, 2).join('.')}`;
assert(paseo === 'all' || pkg.scripts[versionScript], `Unsupported Paseo version: ${paseo}`);
assert(paseo === 'all' || /^\d+\.\d+\.0$/.test(paseo), 'Use an exact supported Paseo version');
assert(process.env.npm_execpath, 'Run through npm run test:snapshot');
assert.equal(await git('status', '--porcelain', '--untracked-files=normal'), '', 'Commit changes first: snapshot tests run committed files only. Use npm run check while editing.');
const revision = await git('rev-parse', '--verify', `${options.get('--ref')}^{commit}`);
// Reuse installed dependencies only when their declared lockfile is unchanged.
for (const path of ['package-lock.json', 'tests/simulation/package-lock.json']) {
  assert.equal(await git('show', `${revision}:${path}`), (await readFile(join(root, path), 'utf8')).trim(), `Dependency lock changed: check out ${revision} and install its dependencies first (${path})`);
}
await access(join(root, 'node_modules'));
if (suite !== 'check') await access(join(root, 'tests/simulation/node_modules'));
const directory = await mkdtemp(join(tmpdir(), 'compact-snapshot-'));
const checkout = join(directory, 'checkout');
const reportDir = join(root, 'test-results', 'snapshots', `${revision}-${Date.now()}`);
await mkdir(reportDir, { recursive: true });
const report = { revision, suite, paseo, platform: process.platform, startedAt: new Date().toISOString(), result: 'running' };
const run = (args) => new Promise((done, fail) => {
  const child = spawn(process.execPath, args, { cwd: checkout, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, GITHUB_SHA: revision } });
  child.on('error', fail);
  child.on('exit', (code, signal) => code === 0 ? done() : fail(new Error(`Test ${signal ? `received ${signal}` : `exited ${code}`}`)));
});
let added = false;
const linked = [];
try {
  await git('worktree', 'add', '--detach', checkout, revision);
  added = true;
  for (const path of ['node_modules', 'tests/simulation/node_modules']) {
    const source = join(root, path);
    try { await access(source); } catch { continue; }
    await symlink(source, join(checkout, path), process.platform === 'win32' ? 'junction' : 'dir');
    linked.push(path);
  }
  console.log(`Testing ${revision} in ${checkout}; reports: ${reportDir}`);
  if (suite !== 'simulation') await run([process.env.npm_execpath, 'run', 'check']);
  if (suite !== 'check') {
    const script = paseo === 'all' ? 'matrix.mjs' : 'run.mjs';
    const args = ['--no-maglev', `tests/simulation/${script}`, '--report-dir', reportDir];
    if (paseo !== 'all') args.push('--paseo', paseo);
    await run(args);
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  try {
    // Unlink dependency junctions before removing the disposable worktree.
    for (const path of linked) {
      await unlink(join(checkout, path)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    if (added) await git('worktree', 'remove', '--force', checkout);
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    report.cleanupError = String(error); report.result = 'failed'; process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, 'snapshot.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.result.toUpperCase()}: ${revision}; ${join(reportDir, 'snapshot.json')}`);
  if (report.error) console.error(report.error);
  if (report.cleanupError) console.error(report.cleanupError);
}
