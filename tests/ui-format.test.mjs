import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canSkip,
  formatTokenThreshold,
  parseTokenThreshold,
} from "../client/format.ts";
test("token thresholds accept shorthand and existing integer inputs exactly", () => {
  for (const [text, tokens] of [
    ["200k", 200000],
    ["250K", 250000],
    [" 1.5m ", 1500000],
    ["200000", 200000],
    ["1.001k", 1001],
    ["1.234567M", 1234567],
    ["0.001k", 1],
    ["10m", 10000000],
    ["200.0000k", 200000],
  ])
    assert.equal(parseTokenThreshold(text), tokens, text);
});
test("token shorthand rejects partial tokens and malformed or unsafe values", () => {
  for (const text of [
    "",
    "k",
    "1.2345k",
    "0.0000001m",
    "1.5",
    "-200k",
    "2e5",
    "Infinity",
    "200kb",
    "200k extra",
    "1,5m",
    "9007199254740992",
    "9".repeat(65),
  ])
    assert.equal(parseTokenThreshold(text), null, text);
});
test("editing a token threshold never rounds an existing value", () => {
  assert.equal(formatTokenThreshold(200000), "200k");
  assert.equal(formatTokenThreshold(1500000), "1.5m");
  for (const tokens of [1, 999, 1000, 1001, 999999, 1000000, 1234567, 10000000])
    assert.equal(parseTokenThreshold(formatTokenThreshold(tokens)), tokens);
  assert.equal(formatTokenThreshold(245312), "245.312k");
});
const row = { revision: "rev", dueAt: 1000, status: "scheduled" };
test("only a current pending reservation offers skip", () => {
  assert.equal(canSkip(row), true);
  for (const status of ["completed", "failed", "unknown", "expired", "skipped", "running"])
    assert.equal(canSkip({ ...row, status }), false);
  assert.equal(canSkip({ ...row, dueAt: null }), false);
  assert.equal(canSkip({ ...row, revision: null }), false);
});
