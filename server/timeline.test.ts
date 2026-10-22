import assert from "node:assert/strict";
import { test } from "node:test";
import { isCompactCommandTurn } from "./timeline";

test("historical compaction must not suppress a later ordinary conversation turn", () => {
  const compact = {
    type: "compaction",
    status: "completed",
    trigger: "manual",
  } as const;
  assert.equal(
    isCompactCommandTurn([{ type: "user_message", text: "/compact" }, compact]),
    true
  );
  assert.equal(
    isCompactCommandTurn([
      { type: "user_message", text: "/compact" },
      compact,
      { type: "user_message", text: "New work" },
      { type: "assistant_message", text: "Done" },
    ]),
    false
  );
});

test("a late compact boundary does not suppress the concurrent ordinary input or its next reservation", () => {
  assert.equal(
    isCompactCommandTurn([
      { type: "user_message", text: "Continue the unfinished work" },
      { type: "compaction", status: "completed", trigger: "manual" },
      { type: "assistant_message", text: "Continued" },
    ]),
    false
  );
  assert.equal(
    isCompactCommandTurn([
      { type: "user_message", text: "/compact preserve decisions" },
    ]),
    true
  );
});
