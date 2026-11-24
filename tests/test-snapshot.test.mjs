import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupScope } from './support/scope.ts';

const STARTED = 'snapshot check started';

test('snapshot keeps testing its recorded commit while the source advances, propagates failure and removes its worktree', async (t) => {
  const scope = cleanupScope(t);
  const root = await scope.folder('compact-snapshot-test-');
  const repo = join(root, 'repo');
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
  await copyFile(new URL('./support/snapshot-check.mjs', import.meta.url), join(repo, 'check.mjs'));
  const git = (...args) => scope.run('git', ['-C', repo, ...args], { timeout: 15_000 });
  await git('init');
  await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
  const revision = (await git('rev-parse', 'HEAD')).stdout.trim();
  // The wrapper makes its worktree in its temp directory, which the scope
  // removes once the wrapper and the check it started have ended.
  const child = await scope.spawn(process.execPath, ['scripts/test-snapshot.mjs'], {
    // The check inherits the wrapper's input through npm and waits on it.
    cwd: repo, timeout: 40_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Rejects on a spawn error as well as resolving on exit.
  const running = once(child, 'exit');
  running.catch(() => {}); // awaited below
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
  child.stdin.end('continue\n');
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
