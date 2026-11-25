import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanupScope } from './support/scope.ts';

// The child's time limit, at which the scope ends it: the unit bound, since the
// child compiles every file it loads before it runs its one short test.
const CHILD_MS = 60_000;
const root = fileURLToPath(new URL('..', import.meta.url));
const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the full unit run uses the focused run\'s command, so both load TypeScript the same way', () => {
  assert.ok(scripts.test.startsWith(`${scripts['test:focused']} `), scripts.test);
});

test('a unit test that checks nothing is pending passes on a cold loader cache', async (t) => {
  const [node, ...flags] = scripts['test:focused'].split(' ');
  assert.equal(node, 'node');
  // The scope gives the child a temp directory of its own, where the loader
  // would keep its cache, so nothing compiled earlier is reused. The child
  // inherits neither this process's cache setting nor its preloads, so only
  // its own command can turn the cache off.
  // Windows reads variable names in any case, so they are matched that way.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !['TSX_DISABLE_CACHE', 'NODE_OPTIONS'].includes(name.toUpperCase())));
  const { temp } = await cleanupScope(t).run(process.execPath, [...flags, 'tests/support/drained-after-load.ts'],
    { cwd: root, env, timeout: CHILD_MS });
  assert.deepEqual((await readdir(temp)).filter(name => name.startsWith('tsx')), []);
});
