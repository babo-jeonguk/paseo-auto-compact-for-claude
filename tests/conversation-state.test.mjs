import assert from "node:assert/strict";
import { test } from "node:test";
import { canUndoSkip, compactCompletionNotice, compactOutcomeNotice, sessionPresentation, pendingPresentation, sessionKey,
  STATUS_GRACE_MS, INPUT_IDLE_GRACE_MS } from "../client/session-state.ts";
import { DEFAULT_SETTINGS } from "../shared/settings.ts";

const now = 1_000_000;
const row = {
  agentId: "a", title: "Example", workspace: "/work", provider: "claude",
  tokens: 245000, revision: "rev", enabled: true,
  status: "scheduled", dueAt: now + 4 * 60000, detail: "",
};
const present = (changes = {}, settings = DEFAULT_SETTINGS, at = now) =>
  sessionPresentation({ ...row, ...changes }, settings, at);

test("countdowns require a future eligible reservation and known sufficient context", () => {
  assert.equal(present().label, "Compact in 4m");
  assert.equal(present({ dueAt: now + 20001 }).label, "Compact in 21s");
  assert.equal(present({ dueAt: now + 60000 }).label, "Compact in 60s");
  assert.equal(present({ dueAt: now }).label, "Compact on");
  assert.equal(present({ dueAt: null }).label, "Compact on");
  for (const tokens of [null, 100]) {
    const view = present({ tokens });
    assert.equal(view.label, "Compact on");
    assert.doesNotMatch(view.description, /will run|Scheduled at|TTL|Cache /);
  }
  assert.match(present({ tokens: 100 }, { ...DEFAULT_SETTINGS, threshold: 400000 }).description, /400k/);
  assert.equal(present({ tokens: 400000 }, { ...DEFAULT_SETTINGS, threshold: 400000 }).label, "Compact in 4m");
});

test("past cancellation, expiry, skip and success return to on without claiming a new reservation", () => {
  for (const status of ["skipped", "expired", "completed"]) {
    const view = present({ status });
    assert.equal(view.label, "Compact on");
    assert.match(view.description, /next reply/);
  }
  assert.match(present({ status: "skipped", undoSkip: { id: "skip", dueAt: now + 60000 } }).description, /Undo skip/);
});

test("running remains visible when automation is off; off explains the correct scope", () => {
  const off = { ...DEFAULT_SETTINGS, enabled: false };
  assert.equal(present({}, off).label, "Compact off");
  assert.match(present({}, off).description, /Settings/);
  assert.match(present({}, { ...DEFAULT_SETTINGS, disabledProviders: ["claude"] }).description, /provider/);
  assert.match(present({ enabled: false }).description, /conversation/);
  assert.equal(present({ enabled: false, status: "running" }, off).label, "Compacting…");
  assert.notDeepEqual(sessionKey("host-a", "a"), sessionKey("host-b", "a"));
  assert.notDeepEqual(sessionKey("host-a", "a"), sessionKey("host-a", "b"));
});

test("actionable failures share one label but preserve their distinct next steps", () => {
  for (const [changes, explanation] of [
    [{ status: "failed" }, /failed/],
    [{ status: "unknown" }, /could not be confirmed/],
    [{ status: "blocked", detail: "Settings unreadable" }, /Settings/],
    [{ status: "blocked", detail: "Claude observer unavailable" }, /Reopen/],
    [{ status: "blocked", detail: "Idle delay exceeds the 5-minute cache window" }, /shorter delay/],
  ]) {
    assert.equal(present(changes).label, "Check compact");
    assert.match(present(changes).description, explanation);
  }
});

test("normal waiting remains on and a persistent pending-input mismatch needs attention", () => {
  for (const detail of ["Waiting for an observed ordinary turn", "Context usage unknown",
    "Cache window passed", "Waiting for cache data", "Waiting for connection"])
    assert.equal(present({ status: "blocked", detail }).label, "Compact on");
  assert.match(present({ status: "busy", busyReason: "permission" }).description, /permission/);
  assert.match(present({ status: "busy", busyReason: "input" }).description, /pending input/);
  assert.equal(present({ status: "busy", busyReason: "input", inputIdleSince: now - INPUT_IDLE_GRACE_MS + 1 }).label, "Compact on");
  const stuck = present({ status: "busy", busyReason: "input", inputIdleSince: now - INPUT_IDLE_GRACE_MS });
  assert.equal(stuck.label, "Check compact");
  assert.match(stuck.description, /if no work is pending/);
  assert.equal(present({ status: "busy", busyReason: "reply", inputIdleSince: null }).label, "Compact on");
});

test("brief reads and mutations use loading, never an old countdown or a sixth label", () => {
  assert.deepEqual(pendingPresentation(null, 0), { presentation: null, loading: true });
  const refreshing = pendingPresentation(present(), STATUS_GRACE_MS - 1);
  assert.equal(refreshing.presentation.label, "Compact on");
  assert.equal(refreshing.loading, true);
  const unavailable = pendingPresentation(present(), STATUS_GRACE_MS);
  assert.equal(unavailable.presentation.label, "Check compact");
  assert.equal(unavailable.loading, false);
  const updating = pendingPresentation(present(), STATUS_GRACE_MS, true);
  assert.equal(updating.presentation.label, "Compact on");
  assert.equal(updating.loading, true);
  const disabled = present({ enabled: false });
  assert.equal(pendingPresentation(disabled, 0).presentation.label, "Compact off");
});

test("undo requires a current explicit skip before its original deadline", () => {
  const skipped = { ...row, status: "skipped", dueAt: null,
    undoSkip: { id: "skip-id", dueAt: now + 60000 } };
  assert.equal(canUndoSkip(skipped, now), true);
  assert.equal(canUndoSkip(skipped, now + 60000), false);
  assert.equal(canUndoSkip({ ...skipped, undoSkip: null }, now), false);
  assert.equal(canUndoSkip({ ...skipped, revision: null }, now), false);
  for (const status of ["scheduled", "busy", "running", "completed", "failed", "unknown", "expired"])
    assert.equal(canUndoSkip({ ...skipped, status }, now), false, status);
});

test("only the matching Compact now operation produces a final toast notice", () => {
  assert.equal(compactCompletionNotice(
    { operationId: "operation-a", status: "running" }, "operation-a"), null);
  assert.equal(compactCompletionNotice(
    { operationId: "operation-b", status: "completed" }, "operation-a"), null);
  assert.deepEqual(compactCompletionNotice(
    { operationId: "operation-a", status: "completed" }, "operation-a"),
  { variant: "success", message: "Conversation compacted" });
  assert.deepEqual(compactCompletionNotice(
    { operationId: "operation-a", status: "unknown" }, "operation-a"),
  { variant: "error", message: "Check the conversation before trying again." });
  assert.deepEqual(compactCompletionNotice(
    { operationId: "operation-a", status: "failed" }, "operation-a"),
  { variant: "error", message: "Couldn’t compact. Check the conversation." });
});

test("a Compact now reply and a polled operation use the same wording", () => {
  const reports = [{ status: "completed" }, { status: "unknown" }, { status: "expired" }, { status: "failed" },
    { status: "failed", detail: "Claude is still working", code: "failed_before_dispatch" }];
  for (const report of reports)
    assert.deepEqual(compactOutcomeNotice(report),
      compactCompletionNotice({ ...report, operationId: "operation-a" }, "operation-a"), JSON.stringify(report));
  // When nothing was sent, the server's reason says what to do before trying again.
  assert.deepEqual(compactOutcomeNotice({ status: "failed", code: "failed_before_dispatch",
    detail: "Session must resume after plugin reload; send a message before compacting" }),
  { variant: "error", message: "Compaction didn’t start; nothing was sent. Session must resume after plugin reload; send a message before compacting." });
  assert.deepEqual(compactOutcomeNotice({ status: "failed", code: "failed_before_dispatch" }),
    { variant: "error", message: "Compaction didn’t start; nothing was sent. Try again." });
  assert.deepEqual(compactOutcomeNotice({ status: "failed", code: "failed_after_dispatch", detail: "Compact turn failed" }),
    { variant: "error", message: "Couldn’t compact. Check the conversation." });
  assert.deepEqual(compactOutcomeNotice({ status: "expired" }),
    { variant: "error", message: "Compaction request expired before it could start; nothing was sent. Try again." });
  assert.deepEqual(compactOutcomeNotice({ status: "blocked", detail: "The conversation is busy. Wait until it finishes" }),
    { variant: "error", message: "The conversation is busy. Wait until it finishes." });
  assert.equal(compactOutcomeNotice({ status: "running" }), null);
});

test("the row tells a failure that sent nothing, and a session awaiting resume, from one to check", () => {
  const settings = { ...DEFAULT_SETTINGS };
  const failed = (code) => ({ ...row, status: "failed", latestOperation: { result: { code, message: "reason" } } });
  assert.match(sessionPresentation(failed("failed_before_dispatch"), settings, 0).description, /nothing was sent/);
  assert.match(sessionPresentation(failed("failed_after_dispatch"), settings, 0).description, /Check the conversation/);
  assert.match(sessionPresentation(failed("failed_before_dispatch"), settings, 0).description, /nothing was sent\. reason\./);
  // Whatever the earlier result, a session awaiting resume says to send a message.
  for (const status of ["blocked", "completed", "failed", "expired"])
    assert.match(sessionPresentation({ ...row, status, resumeRequired: true }, settings, 0).description,
      /Send a message to resume/, status);
});
