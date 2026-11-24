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
      'new setTimeout(fire, 50);',
      "await new Promise(resolve => AbortSignal.timeout(0).addEventListener('abort', resolve));",
      'AbortSignal.timeout(50);',
      "globalThis.AbortSignal['timeout'](TIMEOUT_MS);",
      "const { setTimeout: sleep } = await import('node:timers/promises');",
      "await import('timers');",
      'await import(`node:timers/promises`);',
      "await process.getBuiltinModule('node:timers/promises').setImmediate();",
      "globalThis.process['getBuiltinModule']('timers').setImmediate(fire);",
      "require('node:timers');",
      "import { setTimeout } from 'node:timers/promises';",
      "import { setInterval as every } from 'timers/promises';",
      "import { scheduler } from 'node:timers/promises';",
      "import * as timers from 'node:timers/promises';",
      "import timers from 'timers/promises';",
      "import { setTimeout } from 'node:timers';",
      "import * as timers from 'node:timers';",
    ]) flags(file, code, /CODING_STANDARDS\.md "Tests"/);
    for (const code of [
      'clock.setTimeout(fire, 5_000);',
      't.mock.timers.tick(5_000);',
      // A key built at run time is left to review: lint cannot tell what it names.
      'globalThis[`setTimeout${suffix}`](fire, 50);',
      "const setTimeout = 'setImmediate'; globalThis[setTimeout](fire, 50);",
    ]) passes(file, code);
  }
});

// A turn is not the end of the work under test; only the support helper that
// checks nothing real is pending after its turn may wait for one.
test('unit tests outside tests/support do not wait for a bare event-loop turn', () => {
  const turns = [
    'await new Promise(resolve => setImmediate(resolve));',
    'setImmediate(fire);',
    'globalThis.setImmediate(fire);',
    'setTimeout(resolve, 0);',
    'setTimeout(resolve);',
    'const interval = setInterval(() => { clearInterval(interval); resolve(); }, 0);',
    'setInterval(fire);',
    'new globalThis.setImmediate(fire);',
    'new setTimeout(fire, 0);',
    "import { setImmediate } from 'node:timers/promises';",
    "import { setImmediate } from 'node:timers';",
    "import { 'setImmediate' as immediate } from 'node:timers/promises';",
  ];
  for (const file of ['server/a.test.ts', 'scripts/a.test.ts', 'tests/a.test.mjs'])
    for (const code of turns) flags(file, code, /CODING_STANDARDS\.md "Tests"/);
  for (const code of turns) passes('tests/support/a.ts', code);
  for (const code of ['await drained();', 'await f.timers.tick(5_000);']) passes('server/a.test.ts', code);
});

// A loop that waits for a condition but gives up after a number of turns
// fails on a slower machine and duplicates the runner's bound.
test('unit tests do not wait for a condition by counting turns', () => {
  for (const file of ['server/a.test.ts', 'scripts/a.test.ts', 'tests/a.test.mjs', 'tests/support/a.ts']) {
    for (const code of [
      'for (let i = 0; i < 100 && !done(); i++) await settle();',
      'for (let i = 0; i < 100 && (await read()) !== "done"; i++) await settle();',
      'async function wait() { for (let i = 0; i < 100; i++) { if (done()) return; await settle(); } }',
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

// A test stopped at the runner's bound never reaches its finally, so cleanup
// that waits is registered with the test's cleanup scope, whose hook the
// runner still runs.
test('unit tests register cleanup that waits with their scope, not in finally', () => {
  for (const file of ['server/a.test.ts', 'scripts/a.test.ts', 'tests/a.test.mjs', 'tests/support/a.ts']) {
    for (const code of [
      'try { await run(); } finally { await rm(dir, { recursive: true, force: true }); }',
      'try { await run(); } finally { release(); await running; }',
      'try { await run(); } finally { if (root) await rm(root); }',
      'try { await run(); } finally { for await (const line of lines) log(line); }',
    ]) flags(file, code, /CODING_STANDARDS\.md "Tests"/);
    for (const code of [
      'try { await run(); } finally { release(); }',
      'scope.defer(async () => { await rm(dir, { recursive: true, force: true }); });',
      'try { await run(); } catch { await report(); }',
    ]) passes(file, code);
  }
  for (const file of ['server/a.ts', 'tests/simulation/run.mjs', 'tests/e2e/run.mjs'])
    passes(file, 'try { await run(); } finally { await rm(dir); }');
});

// A folder created anywhere but the scope's helper is removed only if the
// caller registers it afterwards, and a step that throws in between leaks it.
test('unit tests create temporary folders through their cleanup scope', () => {
  const created = [
    "import { mkdtemp } from 'node:fs/promises';",
    "import { mkdtempSync } from 'node:fs';",
    "import { mkdtemp as temporary } from 'fs/promises';",
    'await fs.mkdtemp(prefix);',
    'fs.mkdtempSync(prefix);',
    "await fs['mkdtemp'](prefix);",
    'await fs[`mkdtemp`](prefix);',
    "const { mkdtemp } = await import('node:fs/promises');",
  ];
  for (const file of ['server/a.test.ts', 'scripts/a.test.ts', 'tests/a.test.mjs'])
    for (const code of created) flags(file, code, /CODING_STANDARDS\.md "Tests"/);
  for (const code of created) passes('tests/support/a.ts', code);
  for (const file of ['tests/simulation/run.mjs', 'tests/e2e/run.mjs', 'scripts/a.mjs'])
    passes(file, "import { mkdtemp } from 'node:fs/promises';");
  passes('server/a.test.ts', "const home = await scope.folder('compact-observer-');");
});

// A t.after() hook runs in registration order and stops at the first that
// throws; the scope's one hook releases in reverse order and runs every release.
test('unit tests register cleanup with their scope, not with test hooks', () => {
  const hooks = [
    't.after(() => rm(dir, { recursive: true, force: true }));',
    't.after(async () => { host.stop(); await obs.close(); });',
    'context.after(stop);',
    "t['after'](stop);",
    't.afterEach(stop);',
    'hooks.afterEach(stop);',
    "import { after } from 'node:test';",
    "import { afterEach, test } from 'node:test';",
  ];
  for (const file of ['server/a.test.ts', 'scripts/a.test.ts', 'tests/a.test.mjs'])
    for (const code of hooks) flags(file, code, /CODING_STANDARDS\.md "Tests"/);
  for (const code of hooks) passes('tests/support/a.ts', code);
  for (const code of [
    'scope.defer(() => host.stop());',
    "hooks.on('agent.turn.after', handler);",
    "const event = 'agent.turn.after';",
  ]) passes('server/a.test.ts', code);
});

// A child started anywhere but the scope's helper keeps its own temp files and
// descendants, which a killed child leaves behind.
test('unit tests start child processes through their cleanup scope', () => {
  const started = [
    "import { spawn } from 'node:child_process';",
    "import { execFile, spawn } from 'child_process';",
    "import * as child from 'node:child_process';",
    "import child from 'node:child_process';",
    "export { fork } from 'node:child_process';",
    "const { exec } = await import('node:child_process');",
    "const { execFileSync } = require('child_process');",
    "process.getBuiltinModule('node:child_process').spawn('git');",
    'await import(`node:child_process`);',
  ];
  for (const file of ['server/a.test.ts', 'scripts/a.test.ts', 'tests/a.test.mjs'])
    for (const code of started) flags(file, code, /CODING_STANDARDS\.md "Tests"/);
  flags('server/a.test.ts', "import { type ChildProcess, spawn } from 'node:child_process';", /CODING_STANDARDS\.md "Tests"/);
  for (const code of started) passes('tests/support/a.ts', code);
  for (const file of ['tests/simulation/run.mjs', 'tests/e2e/run.mjs', 'scripts/a.mjs', 'server/a.ts'])
    passes(file, "import { spawn } from 'node:child_process';");
  for (const code of [
    "import type { ChildProcess } from 'node:child_process';",
    "import { type ChildProcess, type SpawnOptions } from 'node:child_process';",
    "await scope.run('git', ['init'], { timeout: GIT_TIMEOUT_MS });",
  ]) passes('server/a.test.ts', code);
});

test('the unit-test real-time rule leaves process suites and product code alone', () => {
  for (const file of ['tests/simulation/run.mjs', 'tests/e2e/run.mjs', 'tests/simulation/a.test.mjs']) {
    passes(file, 'await new Promise(resolve => setTimeout(resolve, 50));');
    passes(file, 'await new Promise(resolve => setImmediate(resolve));');
  }
  for (const file of ['index.server.ts', 'client/a.tsx', 'scripts/a.ts']) {
    passes(file, 'setTimeout(fire, delay);');
    passes(file, 'setImmediate(fire);');
  }
});

// Server code reaches real time only through the injected timers, so a unit
// test drives every wait it makes.
test('server code waits on time only through injected timers', () => {
  for (const file of ['server/a.ts', 'shared/a.ts', 'server/a.mjs']) {
    for (const code of [
      'setTimeout(fire, POLL_MS);',
      'setInterval(tick, TICK_MS);',
      'setImmediate(fire);',
      'new globalThis.setImmediate(fire);',
      'new setTimeout(fire, POLL_MS);',
      'setTimeout(fire);',
      'globalThis.setTimeout(fire, POLL_MS);',
      "globalThis['setImmediate'](fire);",
      'AbortSignal.timeout(REGISTRY_TIMEOUT_MS);',
      "AbortSignal['timeout'](REGISTRY_TIMEOUT_MS);",
      'globalThis.AbortSignal.timeout(REGISTRY_TIMEOUT_MS);',
      "globalThis['AbortSignal'][`timeout`](REGISTRY_TIMEOUT_MS);",
      "import { setTimeout } from 'node:timers/promises';",
      "import { setImmediate } from 'node:timers';",
      "export { setTimeout } from 'node:timers/promises';",
      "export * from 'timers';",
      "await import('node:timers');",
      "process.getBuiltinModule('node:timers/promises');",
      "process['getBuiltinModule'](`timers`);",
      "globalThis.process.getBuiltinModule('node:timers/promises').setImmediate();",
      "require('node:timers');",
    ]) flags(file, code, /CODING_STANDARDS\.md "Decisions apart from effects"/);
    for (const code of [
      'timers.setTimeout(fire, POLL_MS);',
      'clock.setTimeout(fire, Math.max(0, at - now));',
      'timers.clearTimeout(handle);',
      'clearTimeout(handle);',
      'bounded(work, INSPECT_TIMEOUT_MS, timers);',
      'signal.timeout(REGISTRY_TIMEOUT_MS);',
      "process.getBuiltinModule('node:fs');",
      "export { systemTimers } from './deadline';",
    ]) passes(file, code);
  }
});

test('product timer and deadline arguments are named constants', () => {
  // Server code calls no global timer at all, so its timers are injected ones.
  for (const file of ['server/a.ts', 'shared/a.ts', 'server/a.mjs']) {
    for (const code of [
      'timers.setTimeout(fire, 50);',
      'timers.setTimeout(fire, options.pollMs ?? 50);',
      'clock.setTimeout(fire, 1000);',
      'bounded(work, 5_000);',
      'await $.clock.every(5_000, save);',
      'clock.every(500, read);',
    ]) flags(file, code, /CODING_STANDARDS\.md "Named timings"/);
    for (const code of [
      'timers.setTimeout(fire, POLL_MS);',
      'timers.setTimeout(fire, 0);',
      'bounded(work, Math.min(INSPECT_TIMEOUT_MS, deadline - now));',
      'clock.every(HEARTBEAT_MS, save);',
      'items.every(item => item.size > 1000);',
      'items.every(hasAtLeast(1000));',
    ]) passes(file, code);
  }
  for (const file of ['client/a.tsx', 'index.server.ts', 'scripts/a.ts']) {
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
