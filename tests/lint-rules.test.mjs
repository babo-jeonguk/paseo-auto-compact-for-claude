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

test('unit tests start no real timer with a delay outside the shared failure bound', () => {
  for (const file of ['server/a.test.ts', 'scripts/a.test.ts', 'tests/a.test.mjs', 'tests/support/a.ts']) {
    for (const code of [
      'await new Promise(resolve => setTimeout(resolve, 50));',
      'const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));',
      'setInterval(poll, 10);',
      'setInterval(() => poll(agentId), 50);',
      'setInterval(() => { poll(agentId); }, 50);',
      'setTimeout(() => poll(agentId), 50);',
      'globalThis.setTimeout(resolve, 1_000);',
      // A bound of its own, too: bounds live in tests/support/failure-bound.ts.
      'timer = setTimeout(() => resolve(null), ms);',
      "setTimeout(() => reject(new Error('stuck')), 1_000);",
      'setTimeout(reject, FAILURE_BOUND_MS, new Error("stuck"));',
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
      'mock.timers.tick(5_000);',
      "import { setImmediate } from 'node:timers/promises';",
      "import { setImmediate } from 'node:timers';",
    ]) passes(file, code);
  }
  // The one module that owns the failure bound.
  passes('tests/support/failure-bound.ts', 'const timer = setTimeout(() => resolve(null), FAILURE_BOUND_MS);');
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
