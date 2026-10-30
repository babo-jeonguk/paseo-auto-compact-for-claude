import assert from "node:assert/strict";
import { test } from "node:test";
import { DeadlineExceeded } from "./deadline";
import { createReporter } from "./report";

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a defect is reported at once; the host being unavailable only if it outlasts the grace period", async () => {
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line), 20);
  reporter.report(new TypeError("broken"));
  reporter.report(new DeadlineExceeded());
  reporter.report(new Error("Daemon client closed"));
  assert.deepEqual(lines, ["TypeError: broken"]);
  await settle(40);
  assert.deepEqual(lines, ["TypeError: broken", "Error: Compaction deadline exceeded", "Error: Daemon client closed"]);
  reporter.dispose();
});

test("the host becoming unavailable as the plugin shuts down is never reported", async () => {
  const lines: string[] = [];
  const reporter = createReporter(line => lines.push(line), 20);
  reporter.report(new DeadlineExceeded()); // a read stalled by the daemon shutting down
  reporter.report(new Error("Daemon client closed")); // Paseo closed the API before cleanup
  reporter.dispose(); // cleanup
  reporter.report(new TypeError("cut off"));
  await settle(40);
  assert.deepEqual(lines, []);
});
