import assert from "node:assert/strict";
import { test } from "node:test";
import { countdownTickDelay, directoryRefreshDelay, nextRenderAt, operationPollDelay, pollFailures,
  sessionPollDelay, surfaceActive, DIRECTORY_REFRESH_MS, OPERATION_LOOKUP_MS, OPERATION_POLL_MS,
  SESSION_BACKOFF_MS, SESSION_POLL_MS, STATUS_FRESH_MS } from "../client/cadence.ts";
import { STATUS_GRACE_MS } from "../client/session-state.ts";

test("cadences are the agreed values", () => {
  assert.equal(SESSION_POLL_MS, 10_000);
  assert.equal(SESSION_BACKOFF_MS, 30_000);
  assert.equal(OPERATION_POLL_MS, 2_000);
  assert.equal(OPERATION_LOOKUP_MS, 30_000);
  assert.equal(DIRECTORY_REFRESH_MS, 5 * 60_000);
});

test("a visible conversation polls its status at the safety interval; a hidden one does not poll", () => {
  assert.equal(sessionPollDelay({ active: true, failures: 0 }), 10_000);
  assert.equal(sessionPollDelay({ active: false, failures: 0 }), false);
  assert.equal(sessionPollDelay({ active: false, failures: 5 }), false);
});

test("three consecutive failures back off; a success, focus or reconnect restores the interval", () => {
  let failures = 0;
  for (const expected of [10_000, 10_000, 30_000]) {
    failures = pollFailures(failures, "failure");
    assert.equal(sessionPollDelay({ active: true, failures }), expected);
  }
  assert.equal(sessionPollDelay({ active: true, failures: pollFailures(failures, "failure") }), 30_000);
  for (const event of ["success", "focus", "reconnect"]) {
    assert.equal(pollFailures(failures, event), 0);
    assert.equal(sessionPollDelay({ active: true, failures: pollFailures(failures, event) }), 10_000);
  }
});

test("a pending operation keeps the prompt lookup until it ends", () => {
  assert.equal(operationPollDelay({ active: true, found: true, pending: true, elapsed: 0 }), 2_000);
  // An accepted operation may legitimately take minutes; only a missing record is bounded.
  assert.equal(operationPollDelay({ active: true, found: true, pending: true, elapsed: 10 * 60_000 }), 2_000);
  assert.equal(operationPollDelay({ active: true, found: true, pending: false, elapsed: 0 }), false);
  assert.equal(operationPollDelay({ active: false, found: true, pending: true, elapsed: 0 }), false);
});

test("an operation that is never found stops being looked up after 30 seconds", () => {
  assert.equal(operationPollDelay({ active: true, found: false, pending: true, elapsed: 0 }), 2_000);
  assert.equal(operationPollDelay({ active: true, found: false, pending: true, elapsed: 29_999 }), 2_000);
  assert.equal(operationPollDelay({ active: true, found: false, pending: true, elapsed: 30_000 }), false);
});

test("a countdown above one minute next changes at its minute boundary", () => {
  assert.equal(countdownTickDelay(4 * 60_000 + 30_000), 30_000); // 5m -> 4m
  assert.equal(countdownTickDelay(4 * 60_000), 60_000); // 4m -> 3m
  assert.equal(countdownTickDelay(55 * 60_000), 60_000);
  assert.equal(countdownTickDelay(60_000 + 1_000), 1_000); // 2m -> 60s
  assert.equal(countdownTickDelay(60_000 + 1), 1);
});

test("a countdown at or below one minute next changes at its second boundary", () => {
  assert.equal(countdownTickDelay(60_000), 1_000); // 60s -> 59s
  assert.equal(countdownTickDelay(20_001), 1); // 21s -> 20s
  assert.equal(countdownTickDelay(20_000), 1_000);
  assert.equal(countdownTickDelay(1), 1); // 1s -> due
});

test("no active countdown schedules no tick", () => {
  assert.equal(countdownTickDelay(null), null);
  assert.equal(countdownTickDelay(0), null);
  assert.equal(countdownTickDelay(-5_000), null);
});

test("the next render is the earliest visible change: countdown boundary or a future deadline", () => {
  const now = 1_000_000;
  assert.equal(nextRenderAt({ now, dueAt: now + 4 * 60_000 + 30_000 }), now + 30_000);
  assert.equal(nextRenderAt({ now, dueAt: now + 4 * 60_000, deadlines: [now + 5_000] }), now + 5_000);
  assert.equal(nextRenderAt({ now, dueAt: now + 20_000, deadlines: [now + 5_000] }), now + 1_000);
  // Deadlines already passed, missing ones and a missing countdown add nothing.
  assert.equal(nextRenderAt({ now, dueAt: null, deadlines: [now - 1, now, null, undefined] }), null);
  assert.equal(nextRenderAt({ now, deadlines: [now + 25_000, now + 7_000] }), now + 7_000);
  assert.equal(nextRenderAt({ now }), null);
});

test("status stays fresh across one missed poll, and one failed poll does not reach the grace limit", () => {
  assert.ok(STATUS_FRESH_MS >= 2 * SESSION_POLL_MS, "fresh across one missed poll");
  assert.ok(STATUS_FRESH_MS < SESSION_BACKOFF_MS + SESSION_POLL_MS, "but not hiding a dead host for long");
  assert.ok(STATUS_GRACE_MS > SESSION_POLL_MS, "the poll after a failed one lands inside the grace");
  assert.ok(STATUS_GRACE_MS < SESSION_BACKOFF_MS + SESSION_POLL_MS);
});

test("directory discovery refreshes at once on mount, reconnect, visibility and directory changes", () => {
  for (const trigger of ["mount", "reconnect", "visible", "agents-changed"])
    assert.equal(directoryRefreshDelay({ trigger, active: true }), 0, trigger);
  assert.equal(directoryRefreshDelay({ trigger: "interval", active: true }), 5 * 60_000);
});

test("directory discovery does not run while the app is in the background", () => {
  for (const trigger of ["mount", "reconnect", "visible", "agents-changed", "interval"])
    assert.equal(directoryRefreshDelay({ trigger, active: false }), false, trigger);
});

test("only a backgrounded or inactive app counts as hidden", () => {
  assert.equal(surfaceActive("active"), true);
  assert.equal(surfaceActive("background"), false);
  assert.equal(surfaceActive("inactive"), false);
  // Platforms that cannot tell (unknown, absent) keep the conversation live.
  assert.equal(surfaceActive("unknown"), true);
  assert.equal(surfaceActive(null), true);
  assert.equal(surfaceActive(undefined), true);
});

test("every control of one conversation shares its failure count, so backoff is consistent", async () => {
  const { sessionFailures } = await import("../client/cadence.ts");
  const pill = sessionFailures("host:conversation-a"), popover = sessionFailures("host:conversation-a");
  const other = sessionFailures("host:conversation-b");
  for (let i = 0; i < 3; i++) pill.record("failure");
  assert.equal(popover.count(), 3);
  assert.equal(sessionPollDelay({ active: true, failures: popover.count() }), 30_000);
  assert.equal(other.count(), 0);
  popover.record("success");
  assert.equal(pill.count(), 0);
  pill.record("failure");
  other.record("focus");
  assert.equal(popover.count(), 1);
});

test("a conversation's status read that recovers after failures reports that the host is reachable again", async () => {
  const { onSessionRecovered, sessionFailures } = await import("../client/cadence.ts");
  const recovered = [];
  const stop = onSessionRecovered(() => recovered.push("recovered"));
  try {
    const status = sessionFailures("host:conversation-recovery");
    status.record("success");
    assert.deepEqual(recovered, [], "a read that never failed is not a recovery");
    status.record("failure");
    status.record("failure");
    status.record("success");
    assert.deepEqual(recovered, ["recovered"], "the first success after failures is a recovery");
    status.record("success");
    assert.deepEqual(recovered, ["recovered"], "only once per recovery");
    status.record("failure");
    status.record("focus");
    status.record("success");
    assert.deepEqual(recovered, ["recovered"], "regaining focus refreshes discovery on its own, so it is not a recovery");
  } finally {
    stop();
  }
  sessionFailures("host:conversation-recovery").record("failure");
  sessionFailures("host:conversation-recovery").record("success");
  assert.deepEqual(recovered, ["recovered"], "an unsubscribed listener is not called");
});

test("a detected reconnect resets every conversation's backoff and tells mounted status controls to refresh", async () => {
  const { hostReconnected, onHostReconnected, onSessionRecovered, sessionFailures } = await import("../client/cadence.ts");
  const a = sessionFailures("host:reconnect-a"), b = sessionFailures("host:reconnect-b");
  for (let i = 0; i < 3; i++) { a.record("failure"); b.record("failure"); }
  assert.equal(sessionPollDelay({ active: true, failures: a.count() }), 30_000);
  const refreshed = [], recovered = [];
  const stopBroken = onHostReconnected(() => { throw new Error("broken control"); });
  const stop = onHostReconnected(() => refreshed.push("refresh"));
  const stopRecovered = onSessionRecovered(() => recovered.push("recovered"));
  try {
    hostReconnected();
    assert.deepEqual(refreshed, ["refresh"], "a broken listener does not stop the others");
    assert.equal(a.count(), 0);
    assert.equal(b.count(), 0);
    assert.equal(sessionPollDelay({ active: true, failures: b.count() }), 10_000, "back to the ten-second poll");
    a.record("success");
    assert.deepEqual(recovered, [], "a read after a reported reconnect is not another recovery");
  } finally {
    stop(); stopBroken(); stopRecovered();
  }
  hostReconnected();
  assert.deepEqual(refreshed, ["refresh"], "an unsubscribed listener is not called");
});
