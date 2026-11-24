import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const STARTED = 'snapshot check started';

test('snapshot keeps testing its recorded commit while the source advances, propagates failure and removes its worktree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'compact-snapshot-test-'));
  const repo = join(root, 'repo');
  let running;
  // Lets a check still waiting go on, then waits for the wrapper to exit;
  // its spawn timeout bounds that wait, so a signal that cannot be written is
  // ignored: the wrapper still ends at that timeout.
  t.after(async () => {
    await writeFile(join(root, 'continue'), 'cleanup').catch(() => {});
    await running?.catch(() => {}); // a spawn error has already failed the test
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(repo, 'scripts'), { recursive: true });
  await mkdir(join(repo, 'tests/simulation'), { recursive: true });
  await mkdir(join(repo, 'node_modules'));
  await writeFile(join(repo, 'node_modules', 'keep'), 'shared dependencies');
  await copyFile(new URL('../scripts/test-snapshot.mjs', import.meta.url), join(repo, 'scripts/test-snapshot.mjs'));
  await writeFile(join(repo, '.gitignore'), 'node_modules/\ntest-results/\n');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'node check.mjs' } }));
  for (const path of ['package-lock.json', 'tests/simulation/package-lock.json'])
    await writeFile(join(repo, path), '{}\n');
  await writeFile(join(repo, 'value'), 'before');
  await writeFile(join(repo, 'check.mjs'), `
    import { readFile, writeFile, access } from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    console.log('${STARTED}');
    let ready = false;
    for (let i = 0; i < 1000; i++) {
      try { await access(process.env.SNAPSHOT_CONTINUE); ready = true; break; } catch {}
      await setTimeout(20);
    }
    if (!ready || await readFile('value', 'utf8') !== 'before') process.exit(2);
    process.exit(7);
  `);
  const git = (...args) => promisify(execFile)('git', ['-C', repo, ...args], { windowsHide: true, timeout: 15_000 });
  await git('init');
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
  const revision = (await git('rev-parse', 'HEAD')).stdout.trim();
  const proceed = join(root, 'continue');
  const child = spawn(process.execPath, ['scripts/test-snapshot.mjs'], {
    cwd: repo, windowsHide: true, timeout: 40_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SNAPSHOT_CONTINUE: proceed },
  });
  // Rejects on a spawn error as well as resolving on exit.
  running = once(child, 'exit');
  running.catch(() => {}); // awaited below and in the cleanup
  // The check prints its start through the runner, which inherits its output.
  let output = '';
  const printed = new Promise(resolve => {
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output += chunk;
      if (output.includes(STARTED)) resolve();
    });
  });
  await Promise.race([printed, running.then(([code]) => {
    throw new Error(`the snapshot exited ${code} before its check started:\n${output}`);
  })]);
  await writeFile(join(repo, 'value'), 'after');
  await git('add', 'value');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'advance original');
  await writeFile(proceed, 'continue');
  const [code] = await running;
  assert.equal(code, 1, `the wrapper must fail when a snapshot check fails:\n${output}`);
  const reports = join(repo, 'test-results/snapshots');
  const [directory] = await readdir(reports);
  const report = JSON.parse(await readFile(join(reports, directory, 'snapshot.json'), 'utf8'));
  assert.equal(report.revision, revision);
  assert.equal(report.result, 'failed');
  assert.match(report.error, /Test exited 7/, 'the check read the original value, then deliberately failed');
  assert.equal(report.cleanupError, undefined);
  assert.equal((await git('worktree', 'list', '--porcelain')).stdout.match(/^worktree /gm).length, 1);
  assert.equal(await readFile(join(repo, 'node_modules/keep'), 'utf8'), 'shared dependencies');
});
