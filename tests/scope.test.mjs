import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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
