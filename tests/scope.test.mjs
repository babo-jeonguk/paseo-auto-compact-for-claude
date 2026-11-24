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
// the way the runner does when the test ends, one after another.
function context() {
  const hooks = [];
  const notes = [];
  return {
    after: hook => { hooks.push(hook); },
    diagnostic: note => { notes.push(note); },
    hooks, notes,
    async end() { for (const hook of hooks) await hook(); },
  };
}

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

test('a folder from the scope lives in the system temp directory until the test ends, then goes with its contents', async () => {
  const t = context();
  const folder = await cleanupScope(t).folder('compact-scope-');
  assert.equal(dirname(folder), tmpdir());
  await mkdir(join(folder, 'nested'));
  await writeFile(join(folder, 'nested', 'file'), 'content');
  await access(folder);
  await t.end();
  await gone(folder);
});

test('a fixture whose setup throws after creating its folder leaves nothing behind', async () => {
  const t = context();
  let created;
  async function fixture(scope) {
    created = await scope.folder('compact-scope-fixture-');
    throw new Error('setup failed');
  }
  await assert.rejects(fixture(cleanupScope(t)), /setup failed/);
  await t.end();
  await gone(created);
});

test('what was started on a folder stops before the folder goes, so its late write cannot recreate it', async () => {
  const t = context();
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
    const { stdout } = await scope.run('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 15_000 });
    return !stdout.trim().startsWith('Z');
  } catch (error) {
    if (error.code === 1) return false; // ps lists no such process
    throw error;
  }
}

test('a child and its grandchild killed at the spawn timeout leave no process, and the folder they wrote to goes', async (t) => {
  const probe = cleanupScope(t);
  const c = context();
  const scope = cleanupScope(c);
  const child = await scope.spawn(process.execPath, [program, 'tree'], { timeout: 2_000 });
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

test('the end of a test ends the process tree it started before removing the folder it wrote to', async (t) => {
  const probe = cleanupScope(t);
  const c = context();
  const scope = cleanupScope(c);
  const child = await scope.spawn(process.execPath, [program, 'tree'], { timeout: 60_000 });
  const { folder, child: pid, grandchild } = await printed(child, ['folder', 'child', 'grandchild']);
  await c.end();
  assert.equal(await running(probe, Number(pid)), false, 'the child has ended');
  assert.equal(await running(probe, Number(grandchild)), false, 'the grandchild has ended');
  await gone(folder);
  await gone(child.temp);
});

test('a child that already exited leaves nothing to end, and its folder still goes', async () => {
  const c = context();
  const scope = cleanupScope(c);
  const child = await scope.spawn(process.execPath, [program, 'exit', '0'], { timeout: 15_000 });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  await c.end();
  assert.deepEqual(c.notes, []);
  await gone(child.temp);
});

test('run() returns what the child printed, and rejects with its exit code as execFile does', async () => {
  const c = context();
  const scope = cleanupScope(c);
  const ran = await scope.run(process.execPath, [program, 'exit', '0'], { timeout: 15_000 });
  assert.equal(ran.stdout, 'ran\n');
  assert.equal(ran.stderr, '');
  await assert.rejects(scope.run(process.execPath, [program, 'exit', '3'], { timeout: 15_000 }), error => {
    assert.equal(error.code, 3);
    assert.equal(error.signal, null);
    assert.equal(error.stdout, 'ran\n');
    return true;
  });
  await c.end();
  await gone(ran.temp);
});

test('a child that cannot start fails the call and leaves no folder', async () => {
  const c = context();
  const scope = cleanupScope(c);
  let temp;
  await assert.rejects(scope.run(join(tmpdir(), 'compact-missing-program'), [], { timeout: 15_000 }), error => {
    assert.equal(error.code, 'ENOENT');
    temp = error.temp;
    return true;
  });
  await c.end();
  assert.deepEqual(c.notes, []);
  await gone(temp);
});

// The property every test relies on, checked once end to end: a test file whose
// test the runner stops at its bound while it holds folders, a scheduler and a
// process tree. Run as the suite runs, in one process.
test('a test stopped at the runner\'s bound releases what it holds: the run exits on its own and leaves no folder or process', async (t) => {
  const scope = cleanupScope(t);
  const file = fileURLToPath(new URL('./support/stopped-at-bound.ts', import.meta.url));
  const failed = await scope.run(process.execPath,
    ['--import', 'tsx', '--test', '--test-isolation=none', '--test-timeout=4000', file], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 60_000,
      // tsx would otherwise keep its compile cache in the temp directory.
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    }).then(() => assert.fail('the stopped test must fail the run'), error => error);
  assert.equal(failed.signal, null, `the run exited on its own:\n${failed.stdout}`);
  assert.equal(failed.code, 1, failed.stdout);
  assert.match(failed.stdout, /timed out after 4000ms/);
  const [, ...pids] = failed.stdout.match(/holding (\d+) (\d+)/) ?? assert.fail(`the test never held its tree:\n${failed.stdout}`);
  for (const pid of pids) assert.equal(await running(scope, Number(pid)), false, `process ${pid} has ended`);
  assert.deepEqual(await readdir(failed.temp), [], 'nothing is left in the run\'s temp directory');
});
