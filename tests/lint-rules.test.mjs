import assert from 'node:assert/strict';
import test from 'node:test';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { projectRules } from '../eslint.config.mjs';

// The project rules are syntax selectors, so they are checked without type
// information against the files they are scoped to.
const linter = new Linter({ configType: 'flat' });
const config = [{ files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } }, ...projectRules];
const findings = (file, code) => linter.verify(code, config, file).map(({ message, fatal }) => {
  assert(!fatal, message);
  return message;
});
const flags = (file, code, standard) => {
  const messages = findings(file, code);
  assert.equal(messages.length, 1, `${file}: ${code}\n${messages.join('\n')}`);
  assert.match(messages[0], standard);
};
const passes = (file, code) => assert.deepEqual(findings(file, code), [], `${file}: ${code}`);

// The test runner bounds every unit test, so no test starts a real timer of
// its own, not even to bound a wait.
test('unit tests start no real timer with a delay', () => {
  for (const file of ['server/a.test.ts', 'scripts/a.test.ts', 'tests/a.test.mjs', 'tests/support/a.ts']) {
    for (const code of [
      'await new Promise(resolve => setTimeout(resolve, 50));',
      'const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));',
      'setInterval(poll, 10);',
      'setInterval(() => poll(agentId), 50);',
      'setInterval(() => { poll(agentId); }, 50);',
      'setTimeout(() => poll(agentId), 50);',
      'globalThis.setTimeout(resolve, 1_000);',
      'global.setInterval(poll, 10);',
      "globalThis['setTimeout'](resolve, 50);",
      'globalThis[`setInterval`](poll, 10);',
      'timer = setTimeout(() => resolve(null), ms);',
      "setTimeout(() => reject(new Error('stuck')), 1_000);",
      "const { setTimeout: sleep } = await import('node:timers/promises');",
      "await import('timers');",
      'await import(`node:timers/promises`);',
      "import { setTimeout } from 'node:timers/promises';",
      "import { setInterval as every } from 'timers/promises';",
      "import { scheduler } from 'node:timers/promises';",
      "import * as timers from 'node:timers/promises';",
      "import timers from 'timers/promises';",
      "import { setTimeout } from 'node:timers';",
      "import * as timers from 'node:timers';",
    ]) flags(file, code, /CODING_STANDARDS\.md "Tests"/);
    for (const code of [
      'await new Promise(resolve => setImmediate(resolve));',
      'setTimeout(resolve, 0);',
      'setTimeout(resolve);',
      'clock.setTimeout(fire, 5_000);',
      't.mock.timers.tick(5_000);',
      "import { setImmediate } from 'node:timers/promises';",
      "import { setImmediate } from 'node:timers';",
      // A key built at run time is left to review: lint cannot tell what it names.
      'globalThis[`setTimeout${suffix}`](fire, 50);',
      "const setTimeout = 'setImmediate'; globalThis[setTimeout](fire, 50);",
      "import { 'setImmediate' as immediate } from 'node:timers/promises';",
    ]) passes(file, code);
  }
});

// A loop that waits for a condition but gives up after a number of turns
// fails on a slower machine and duplicates the runner's bound.
test('unit tests do not wait for a condition by counting turns', () => {
  for (const file of ['server/a.test.ts', 'scripts/a.test.ts', 'tests/a.test.mjs', 'tests/support/a.ts']) {
    for (const code of [
      'for (let i = 0; i < 100 && !done(); i++) await settle();',
      'for (let i = 0; i < 100 && (await read()) !== "done"; i++) await settle();',
      'async function wait() { for (let i = 0; i < 100; i++) { if (done()) return; await settle(); } }',
      'for (let i = 0; i < 100; i++) { if (done()) break; await new Promise(resolve => setImmediate(resolve)); }',
    ]) flags(file, code, /CODING_STANDARDS\.md "Tests"/);
    for (const code of [
      'for (let i = 0; i < 19; i++) await f.tick();',
      'while (!done()) await changed();',
      'for (const page of pages) { if (!page) break; await read(page); }',
      'for (let i = 0; i < 5; i++) assert.equal(await read(), 1);',
    ]) passes(file, code);
  }
  passes('server/a.ts', 'for (let i = 0; i < 100 && !done(); i++) await settle();');
});

// A mock on the shared tracker outlives a test stopped at the runner's bound,
// whose finally never runs; the test context's mocks are restored by the runner.
test('unit tests mock through their test context, not the shared tracker', () => {
  for (const file of ['server/a.test.ts', 'tests/a.test.mjs', 'tests/support/a.ts']) {
    for (const code of [
      "mock.timers.enable({ apis: ['setTimeout'] });",
      'mock.timers.tick(5_000);',
      "mock.method(console, 'error');",
    ]) flags(file, code, /CODING_STANDARDS\.md "Tests"/);
    for (const code of [
      "t.mock.timers.enable({ apis: ['setTimeout'] });",
      't.mock.timers.tick(5_000);',
      "t.mock.method(console, 'error');",
      'const fake = mock.fn();',
    ]) passes(file, code);
  }
});

test('the real-time rule leaves process suites and product code alone', () => {
  for (const file of ['tests/simulation/run.mjs', 'tests/e2e/run.mjs', 'tests/simulation/a.test.mjs'])
    passes(file, 'await new Promise(resolve => setTimeout(resolve, 50));');
  passes('server/scheduler.ts', 'setTimeout(fire, delay);');
});

test('product timer and deadline arguments are named constants', () => {
  for (const file of ['server/a.ts', 'client/a.tsx', 'shared/a.ts', 'index.server.ts', 'scripts/a.ts', 'server/a.mjs']) {
    for (const code of [
      'setTimeout(fire, 50);',
      'setInterval(tick, 10_000);',
      'globalThis.setTimeout(fire, 5 * 60_000);',
      'setTimeout(fire, options.pollMs ?? 50);',
      'clock.setTimeout(fire, 1000);',
      'bounded(work, 5_000);',
      'await $.clock.every(5_000, save);',
      'AbortSignal.timeout(15_000);',
      'setTimeout(fire, .5);',
      'clock.every(500, read);',
    ]) flags(file, code, /CODING_STANDARDS\.md "Named timings"/);
    for (const code of [
      'setTimeout(fire, POLL_MS);',
      'setTimeout(fire, Math.max(0, at - now));',
      'setTimeout(fire, 0);',
      'bounded(work, Math.min(INSPECT_TIMEOUT_MS, deadline - now));',
      'clock.every(HEARTBEAT_MS, save);',
      'items.every(item => item.size > 1000);',
      'items.every(hasAtLeast(1000));',
      'AbortSignal.timeout(REGISTRY_TIMEOUT_MS);',
    ]) passes(file, code);
  }
});

test('the timing rule leaves tests alone', () => {
  for (const file of ['server/a.test.ts', 'tests/simulation/run.mjs', 'tests/e2e/run.mjs'])
    passes(file, 'bounded(work, 5_000);');
});
