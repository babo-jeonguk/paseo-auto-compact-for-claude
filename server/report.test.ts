import assert from "node:assert/strict";
import { test } from "node:test";
import { DeadlineExceeded, Stopped } from "./deadline";
import { createReporter, REPORT_GRACE_MS } from "./report";
import { cleanupScope } from "../tests/support/scope";
import { fakeTimers } from "../tests/support/timers";

test("a defect is reported at once; the host being unavailable only if it outlasts the grace period", async (t) => {
  const timers = fakeTimers();
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line), REPORT_GRACE_MS, timers);
  cleanupScope(t).defer(() => reporter.dispose());
  reporter.report(new TypeError("broken"));
  reporter.report(new DeadlineExceeded());
  reporter.report(new Error("Daemon client closed"));
  assert.deepEqual(lines, ["TypeError: broken"]);
  // A grace timer runs within the tick that brings it due, so none ran before the grace period ends.
  await timers.tick(REPORT_GRACE_MS - 1);
  assert.deepEqual(lines, ["TypeError: broken"]);
  await timers.tick(1);
  assert.deepEqual(lines, ["TypeError: broken", "Error: Compaction deadline exceeded", "Error: Daemon client closed"]);
  assert.equal(timers.pending, 0);
  assert.equal(REPORT_GRACE_MS, 30_000);
});

test("the host becoming unavailable as the plugin shuts down is never reported, but a defect of work already issued is", async () => {
  const timers = fakeTimers();
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line), REPORT_GRACE_MS, timers);
  reporter.report(new DeadlineExceeded()); // a read stalled by the daemon shutting down
  reporter.report(new Error("Daemon client closed")); // Paseo closed the API before cleanup
  reporter.dispose(); // cleanup
  // Work issued before the stop can still fail after it.
  reporter.report(new TypeError("cut off"));
  reporter.report(new Error("Daemon client closed"));
  reporter.report(new Stopped());
  assert.equal(timers.pending, 0, "disposal cleared every grace timer");
  await timers.tick(REPORT_GRACE_MS);
  assert.deepEqual(lines, ["TypeError: cut off"]);
});

test("a failing teardown step after disposal is still reported unless the host is gone", () => {
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line));
  reporter.dispose();
  reporter.teardown(new TypeError("unsubscribe broke"));
  reporter.teardown(new Error("Daemon client closed")); // Paseo closed the API before cleanup
  reporter.teardown(new DeadlineExceeded());
  assert.deepEqual(lines, ["TypeError: unsubscribe broke"]);
});

test("a group of failures is classified cause by cause", async () => {
  const timers = fakeTimers();
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line), REPORT_GRACE_MS, timers);
  reporter.report(new AggregateError([new TypeError("one read broke"), new DeadlineExceeded(),
    new AggregateError([new RangeError("nested defect"), new Stopped()])], "Observation pass failed"));
  assert.deepEqual(lines, ["TypeError: one read broke", "RangeError: nested defect"],
    "every defect in the group is reported at once");
  await timers.tick(REPORT_GRACE_MS);
  assert.deepEqual(lines, ["TypeError: one read broke", "RangeError: nested defect",
    "Error: Compaction deadline exceeded"], "the host condition in it waits out the grace period");
  reporter.dispose();
  reporter.teardown(new AggregateError([new Error("Daemon client closed"), new TypeError("release broke")]));
  assert.equal(lines.at(-1), "TypeError: release broke");
  assert.equal(lines.length, 4);
});

test("the plugin's own stop is never reported", async () => {
  const timers = fakeTimers();
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line), REPORT_GRACE_MS, timers);
  reporter.report(new Stopped());
  assert.equal(timers.pending, 0);
  reporter.dispose();
  reporter.teardown(new Stopped());
  assert.deepEqual(lines, []);
});

test("during teardown a failure handed over by several owners is logged once", () => {
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line));
  reporter.dispose();
  // A nested write, the write around it and a stopped wait can all see one failure.
  const failure = new Error("EIO: rename");
  reporter.teardown(failure);
  reporter.report(failure);
  reporter.teardown(new AggregateError([failure, new Error("EACCES: rm")]));
  assert.deepEqual(lines, ["Error: EIO: rename", "Error: EACCES: rm"]);
});
