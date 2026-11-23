import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { DeadlineExceeded } from "./deadline";
import { createReporter, REPORT_GRACE_MS } from "./report";

test("a defect is reported at once; the host being unavailable only if it outlasts the grace period", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const lines: string[] = [];
    const reporter = createReporter(line => lines.push(line));
    reporter.report(new TypeError("broken"));
    reporter.report(new DeadlineExceeded());
    reporter.report(new Error("Daemon client closed"));
    assert.deepEqual(lines, ["TypeError: broken"]);
    mock.timers.tick(REPORT_GRACE_MS - 1);
    assert.deepEqual(lines, ["TypeError: broken"]);
    mock.timers.tick(1);
    assert.deepEqual(lines, ["TypeError: broken", "Error: Compaction deadline exceeded", "Error: Daemon client closed"]);
    assert.equal(REPORT_GRACE_MS, 30_000);
    reporter.dispose();
  } finally { mock.timers.reset(); }
});

test("the host becoming unavailable as the plugin shuts down is never reported", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const lines: string[] = [];
    const reporter = createReporter(line => lines.push(line));
    reporter.report(new DeadlineExceeded()); // a read stalled by the daemon shutting down
    reporter.report(new Error("Daemon client closed")); // Paseo closed the API before cleanup
    reporter.dispose(); // cleanup
    reporter.report(new TypeError("cut off"));
    mock.timers.tick(REPORT_GRACE_MS);
    assert.deepEqual(lines, []);
  } finally { mock.timers.reset(); }
});
