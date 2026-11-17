# Coding standards

Rules for reviewing a change in this repository. Each one is a judgement call; cite it by its heading.

## Documentation tiers

- `README.md` and `OVERVIEW.md` are for users and the registry listing: what the plugin does, how to install, use, update and remove it, its controls and settings, and what data it touches. Timing internals, event ordering, races and recovery rules there are a finding.
- `docs/runtime.md` is the contract the code is checked against. A behavior change without a matching `docs/runtime.md` change, or a sentence there broader than the code, is a finding.
- `docs/development.md` describes the code layout and module responsibilities, and `docs/testing.md` how to run the suites. Dated results and investigation notes do not belong in either.

## One rule, one place

A rule lives in the module that owns it, and every caller asks that module. The automatic compaction policy is in `server/policy.ts`, which both the scheduler and the worker call; deadlines and timeouts are in `server/deadline.ts`; client polling cadences are in `client/cadence.ts`. A copy of a rule, or a second constant with the same meaning, is a finding.

## Named timings

Every duration is a named constant with a unit suffix (`_MS`) and a comment that says why it has that value. Tests assert the agreed values. A bare number of milliseconds in logic is a finding.

## Decisions apart from effects

Keep decisions as pure functions that take the current time and state as input (`automaticBlock`, `sessionPollDelay`, `deadlineOf`), and keep timers, I/O and the host API at the edges. Code that reads the clock or the host inside a decision is harder to test and is a finding when a pure version is practical.

## Never send twice

Compaction is a side effect that cannot be undone. Work that may have been sent (it has a dispatch marker) is never resent; when the outcome cannot be proven it ends `unknown`, not retried. A timeout bounds waiting; it does not cancel remote work. A change that can resend or report success without native evidence is a blocking finding.

## Durable state stays compatible

State, settings and RPC payloads are validated with zod schemas at the boundary. Format changes are additive, so the previous release can still read the file after a rollback, and older formats are migrated on read with stable IDs. A breaking format change, or an unvalidated read of stored or remote data, is a finding.

## Errors are classified

Separate conditions the plugin expects and retries from durable state (the host not answering, a deadline) from defects. Report a defect at once and an outage only after its grace period (`server/report.ts`). Swallowing an error without a comment that says why is a finding.

## Host compatibility by capability

The plugin supports Paseo 0.12 and later, and SDK 0.12 stays the compile-time contract. Detect a newer host feature by checking for it (`typeof … === "function"`), not by comparing version strings, and keep the older path working. Never reject a Paseo or Claude Code version outright; let a real mismatch surface as a real failure.

## General path first

Make code work in the general case, then add special handling on top. Do not depend on one OS, path form, exact wording or timing, and do not fail everything when an optional signal is missing: keep a reservation with a stated assumption rather than blocking the feature.

## Tests

- Tests use `node:test` with `node:assert/strict`, and drive time through an injected clock rather than sleeps.
- Wait on observable state, not on incidental counts or delays. Do not hide a failure with retries or weaker assertions.
- A change in how the plugin talks to Paseo or Claude needs a native simulation scenario, since unit fakes share the code's assumptions.

## Comments say why

Comments explain why code is the way it is: the host behavior it works around, the race it closes, the version that needs it. A comment that restates the code, or code whose reason is not obvious and has no comment, is a finding.

## Generated and checked files

`server/observer-assets.generated.ts` is generated from `server/observer-source.mjs` by `npm run build:observer`; edit the source, never the generated file. Text files use LF line endings on every OS.
