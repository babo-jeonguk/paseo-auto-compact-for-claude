import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cleanupScope } from './support/scope.ts';

// A test context as the scope sees it: `end()` runs the hooks it registered
// the way the runner does when the test ends, one after another, once. Given
// the real test's context `t`, it also ends when that test does, so a check
// that fails before calling `end()` still leaves no folder or process.
function context(t) {
  const hooks = [];
  const notes = [];
  let ending;
  const c = {
    after: hook => { hooks.push(hook); },
    // Printed under the real test too, where its cleanup failures show.
    diagnostic: note => { notes.push(note); t?.diagnostic(note); },
    hooks, notes,
    end() { return ending ??= (async () => { for (const hook of hooks) await hook(); })(); },
  };
  if (t) cleanupScope(t).defer(() => c.end());
  return c;
}

// How long a child the tests start may take: far more than starting Node and
// printing a line takes on a slow CI runner.
const CHILD_MS = 15_000;
// The limit the tree test lets pass: short, since the test waits it out.
const HUNG_CHILD_MS = 2_000;
// The runner's bound in the end-to-end test: long enough for the stopped test
// to acquire everything and print its PIDs first.
const RUNNER_BOUND_MS = 4_000;
// The end-to-end run as a whole: a fresh Node with tsx and its own runner.
// Longer than the stopped test's own child limit (20 s), so a scope that
// failed to release still ends that tree before this run is ended, and
// shorter than the suite's 60 s bound on this test.
const RUNNER_RUN_MS = 40_000;

const gone = path => assert.rejects(access(path), { code: 'ENOENT' }, `${path} is left behind`);

test('releases run once the test ends, in reverse order of acquisition', async () => {
  const t = context();
  const scope = cleanupScope(t);
  const ran = [];
  scope.defer(() => { ran.push('first'); });
  scope.defer(async () => { ran.push('second'); });
  assert.deepEqual(ran, []);
  await t.end();
  assert.deepEqual(ran, ['second', 'first']);
});

test('a fixture and its caller given the same test context share one scope and one hook', async () => {
  const t = context();
  const ran = [];
  cleanupScope(t).defer(() => { ran.push('fixture'); });
  cleanupScope(t).defer(() => { ran.push('caller'); });
  assert.equal(t.hooks.length, 1);
  await t.end();
  assert.deepEqual(ran, ['caller', 'fixture']);
});

test('a failing release does not stop the others, and every failure is reported in the order they ran', async () => {
  const t = context();
  const scope = cleanupScope(t);
  const ran = [];
  scope.defer(() => { ran.push('first'); });
  scope.defer(() => { throw new Error('one'); });
  scope.defer(() => { ran.push('third'); });
  scope.defer(async () => { throw new Error('two'); });
  await assert.rejects(t.end(), error => {
    assert(error instanceof AggregateError, String(error));
    assert.deepEqual(error.errors.map(failure => failure.message), ['two', 'one']);
    return true;
  });
  assert.deepEqual(ran, ['third', 'first']);
  // Also printed, so they show when the test's own failure is the one the runner reports.
  assert.equal(t.notes.length, 2);
  assert.match(t.notes[0], /two/);
  assert.match(t.notes[1], /one/);
});

test('one failing release is reported as itself', async () => {
  const t = context();
  const failure = new Error('only');
  cleanupScope(t).defer(() => { throw failure; });
  await assert.rejects(t.end(), error => error === failure);
  assert.equal(t.notes.length, 1);
});

test('a folder from the scope lives in the system temp directory until the test ends, then goes with its contents', async (outer) => {
  const t = context(outer);
  const folder = await cleanupScope(t).folder('compact-scope-');
  assert.equal(dirname(folder), tmpdir());
  await mkdir(join(folder, 'nested'));
  await writeFile(join(folder, 'nested', 'file'), 'content');
  await access(folder);
  await t.end();
  await gone(folder);
});

test('a fixture whose setup throws after creating its folder leaves nothing behind', async (outer) => {
  const t = context(outer);
  let created;
  async function fixture(scope) {
    created = await scope.folder('compact-scope-fixture-');
    throw new Error('setup failed');
  }
  await assert.rejects(fixture(cleanupScope(t)), /setup failed/);
  await t.end();
  await gone(created);
});

test('what was started on a folder stops before the folder goes, so its late write cannot recreate it', async (outer) => {
  const t = context(outer);
  const scope = cleanupScope(t);
  const folder = await scope.folder('compact-scope-writer-');
  // A writer whose stop lands one last write, as a store or gateway may.
  scope.defer(() => writeFile(join(folder, 'state.json'), 'late'));
  await t.end();
  await gone(folder);
});

const program = fileURLToPath(new URL('./support/child.mjs', import.meta.url));

// Reads the `<what> <value>` lines a child prints until it has printed each
// of `names`; fails if its output ends first.
async function printed(child, names) {
  const values = {};
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const [name, ...rest] = line.split(' ');
      values[name] = rest.join(' ');
      if (names.every(wanted => wanted in values)) return values;
    }
  } finally {
    child.stdout.resume(); // the rest is read and dropped, so the output can end
  }
  throw new Error(`the child ended after printing only ${JSON.stringify(values)}`);
}

// Whether a process can still act: a zombie waiting to be reaped cannot.
async function running(scope, pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform === 'win32') return true;
  try {
    const { stdout } = await scope.run('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: CHILD_MS });
    return !stdout.trim().startsWith('Z');
  } catch (error) {
    if (error.code === 1) return false; // ps lists no such process
    throw error;
  }
}

test('a child and its grandchild killed at the spawn timeout leave no process, and the folder they wrote to goes', async (t) => {
  const probe = cleanupScope(t);
  const c = context(t);
  const scope = cleanupScope(c);
  const child = await scope.spawn(process.execPath, [program, 'tree'], { timeout: HUNG_CHILD_MS });
  const closed = once(child, 'close');
  const { folder, grandchild } = await printed(child, ['folder', 'child', 'grandchild']);
  // The child's temp directory is a folder of the test's own.
  assert.equal(dirname(dirname(folder)), tmpdir());
  assert.match(folder, /compact-child-made-/);
  assert.equal(dirname(folder), child.temp);
  const [code, signal] = await closed;
  assert.equal(code === 0, false, `the child was killed, not finished (${code}, ${signal})`);
  assert.equal(await running(probe, Number(grandchild)), false, 'the grandchild ends with the child');
  await access(folder);
  await c.end();
  await gone(child.temp);
});

// POSIX lets the grandchild outlive the child and hold the output open, the
// hang the limit bounds; Windows ends a Node child's children with it.
test('a run whose child exits while a grandchild holds its output ends by its limit and leaves no process', async (t) => {
  const probe = cleanupScope(t);
  const c = context(t);
  const scope = cleanupScope(c);
  const outcome = await scope.run(process.execPath, [program, 'orphan'], { timeout: HUNG_CHILD_MS })
    .then(ran => ({ ...ran, code: 0 }), error => error);
  assert.equal(outcome.code, 0, `the child exited on its own:\n${outcome.stdout}`);
  const [, grandchild, child] = outcome.stdout.match(/grandchild (\d+)\nchild (\d+)/) ?? [];
  assert.ok(child && grandchild, `both printed their PIDs:\n${outcome.stdout}`);
  assert.equal(await running(probe, Number(grandchild)), false, 'the grandchild has ended');
});

test('the end of a test ends the process tree it started before removing the folder it wrote to', async (t) => {
  const probe = cleanupScope(t);
  const c = context(t);
  const scope = cleanupScope(c);
  const child = await scope.spawn(process.execPath, [program, 'tree'], { timeout: CHILD_MS });
  const { folder, child: pid, grandchild } = await printed(child, ['folder', 'child', 'grandchild']);
  await c.end();
  assert.equal(await running(probe, Number(pid)), false, 'the child has ended');
  assert.equal(await running(probe, Number(grandchild)), false, 'the grandchild has ended');
  await gone(folder);
  await gone(child.temp);
});

test('a child that already exited leaves nothing to end, and its folder still goes', async (t) => {
  const c = context(t);
  const scope = cleanupScope(c);
  const child = await scope.spawn(process.execPath, [program, 'exit', '0'], { timeout: CHILD_MS });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  await c.end();
  assert.deepEqual(c.notes, []);
  await gone(child.temp);
});

test('run() returns what the child printed, and rejects with its exit code as execFile does', async (t) => {
  const c = context(t);
  const scope = cleanupScope(c);
  const ran = await scope.run(process.execPath, [program, 'exit', '0'], { timeout: CHILD_MS });
  assert.equal(ran.stdout, 'ran\n');
  assert.equal(ran.stderr, '');
  await assert.rejects(scope.run(process.execPath, [program, 'exit', '3'], { timeout: CHILD_MS }), error => {
    assert.equal(error.code, 3);
    assert.equal(error.signal, null);
    assert.equal(error.stdout, 'ran\n');
    return true;
  });
  await c.end();
  await gone(ran.temp);
});

test('a child that cannot start fails the call and leaves no folder', async (t) => {
  const c = context(t);
  const scope = cleanupScope(c);
  let temp;
  await assert.rejects(scope.run(join(tmpdir(), 'compact-missing-program'), [], { timeout: CHILD_MS }), error => {
    assert.equal(error.code, 'ENOENT');
    temp = error.temp;
    return true;
  });
  await c.end();
  assert.deepEqual(c.notes, []);
  await gone(temp);
});

test('a child cannot be given an IPC channel, which the scope could not close for it', async (t) => {
  const c = context(t);
  const scope = cleanupScope(c);
  await assert.rejects(scope.spawn(process.execPath, [program, 'exit', '0'],
    { timeout: CHILD_MS, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }), /no IPC channel/);
  await c.end();
  assert.deepEqual(c.notes, []);
});

// The property every test relies on, checked once end to end: a test file whose
// test the runner stops at its bound while it holds folders, a scheduler and a
// process tree. Run as the suite runs, in one process.
test('a test stopped at the runner\'s bound releases what it holds: the run exits on its own and leaves no folder or process', async (t) => {
  const scope = cleanupScope(t);
  const file = fileURLToPath(new URL('./support/stopped-at-bound.ts', import.meta.url));
  const failed = await scope.run(process.execPath,
    ['--import', 'tsx', '--test', '--test-isolation=none', `--test-timeout=${RUNNER_BOUND_MS}`, file], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: RUNNER_RUN_MS,
      // tsx would otherwise keep its compile cache in the temp directory.
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    }).then(() => assert.fail('the stopped test must fail the run'), error => error);
  assert.equal(failed.signal, null, `the run exited on its own:\n${failed.stdout}`);
  assert.equal(failed.code, 1, failed.stdout);
  assert.match(failed.stdout, new RegExp(`timed out after ${RUNNER_BOUND_MS}ms`));
  const [, ...pids] = failed.stdout.match(/holding (\d+) (\d+)/) ?? assert.fail(`the test never held its tree:\n${failed.stdout}`);
  for (const pid of pids) assert.equal(await running(scope, Number(pid)), false, `process ${pid} has ended`);
  assert.deepEqual(await readdir(failed.temp), [], 'nothing is left in the run\'s temp directory');
});
