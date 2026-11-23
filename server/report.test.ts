import assert from "node:assert/strict";
import { test } from "node:test";
import { DeadlineExceeded } from "./deadline";
import { createReporter, REPORT_GRACE_MS } from "./report";

test("a defect is reported at once; the host being unavailable only if it outlasts the grace period", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line));
  t.after(() => reporter.dispose());
  reporter.report(new TypeError("broken"));
  reporter.report(new DeadlineExceeded());
  reporter.report(new Error("Daemon client closed"));
  assert.deepEqual(lines, ["TypeError: broken"]);
  t.mock.timers.tick(REPORT_GRACE_MS - 1);
  assert.deepEqual(lines, ["TypeError: broken"]);
  t.mock.timers.tick(1);
  assert.deepEqual(lines, ["TypeError: broken", "Error: Compaction deadline exceeded", "Error: Daemon client closed"]);
  assert.equal(REPORT_GRACE_MS, 30_000);
});

test("the host becoming unavailable as the plugin shuts down is never reported", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line));
  reporter.report(new DeadlineExceeded()); // a read stalled by the daemon shutting down
  reporter.report(new Error("Daemon client closed")); // Paseo closed the API before cleanup
  reporter.dispose(); // cleanup
  reporter.report(new TypeError("cut off"));
  t.mock.timers.tick(REPORT_GRACE_MS);
  assert.deepEqual(lines, []);
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
