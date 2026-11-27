import assert from "node:assert/strict";
import { test } from "node:test";
import { createGroup } from "./group";
import { gate } from "../tests/support/gate";
import { drainer } from "../tests/support/drained";
import { cleanupScope } from "../tests/support/scope";

// A child that only loads one small module and crashes on its first rejection.
const CHILD_MS = 15_000;

test("tracking work gives the caller the work's own value and rejection", async () => {
  const group = createGroup();
  assert.equal(await group.track(Promise.resolve("value")), "value");
  const failure = new Error("tracked work failed");
  const rejected = group.track(Promise.reject(failure)).then(() => null, (error: unknown) => error);
  assert.equal(await rejected, failure, "the caller's view rejects with the work's own error");
});

test("idle resolves once every tracked task has settled, including ones tracked while waiting, and never rejects", async () => {
  const group = createGroup();
  const drained = drainer();
  assert.equal(group.busy(), false);
  assert.equal(await group.idle(), undefined, "an empty group is idle");
  let fail!: (error: Error) => void;
  const failing = group.track(new Promise<never>((_resolve, reject) => { fail = reject; }))
    .then(() => null, (error: unknown) => error);
  const held = gate();
  const passing = group.track(held.pass());
  assert.equal(group.busy(), true);
  let idle = false;
  const waiting = group.idle().then(() => { idle = true; });
  const failure = new Error("one task failed");
  fail(failure);
  assert.equal(await failing, failure);
  await held.reached;
  let finish!: () => void;
  const late = group.track(new Promise<void>(resolve => { finish = resolve; }));
  held.release();
  await passing;
  await drained();
  assert.equal(idle, false, "work tracked while waiting holds idle too");
  assert.equal(group.busy(), true);
  finish();
  await late;
  await waiting;
  assert.equal(idle, true);
  assert.equal(group.busy(), false);
});

test("a tracked rejection the caller drops is an unhandled rejection", async (t) => {
  const scope = cleanupScope(t);
  // A file URL, which imports the same on every OS.
  const module = new URL("./group.ts", import.meta.url).href;
  // The caller drops the promise `track` returns; nothing in the group may
  // mark its rejection handled.
  const program = `import { createGroup } from ${JSON.stringify(module)};\n` +
    `const group = createGroup();\n` +
    `group.track(Promise.reject(new Error("dropped-sentinel")));\n` +
    `await group.idle();\n`;
  const outcome = await scope.run(process.execPath,
    ["--unhandled-rejections=strict", "--input-type=module", "--eval", program], { timeout: CHILD_MS })
    .then(() => null, (error: { code?: number; stderr?: string }) => error);
  assert.ok(outcome, "the child does not exit cleanly");
  assert.notEqual(outcome.code, 0);
  assert.match(outcome.stderr ?? "", /Error: dropped-sentinel/, "the child fails on the dropped rejection itself");
});
