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

Lint enforces this for the delay argument of timer calls in product code (`setTimeout`, `setInterval`, `bounded`, a clock's `every`, `AbortSignal.timeout`); other durations in logic are left to review.

## Decisions apart from effects

Keep decisions as pure functions that take the current time and state as input (`automaticBlock`, `sessionPollDelay`, `deadlineOf`), and keep timers, I/O and the host API at the edges. Code that reads the clock or the host inside a decision is harder to test and is a finding when a pure version is practical.

Server code (`server/`, `shared/`) waits on time only through the injected timers (`Timers`), whose one real implementation is `systemTimers` in `server/deadline.ts`; the plugin's entry point wires real time in. So a unit test drives every wait the code makes and can tell when it has nothing left to run. Lint rejects a global timer or immediate, `AbortSignal.timeout` and the timer modules there.

## Never send twice

Compaction is a side effect that cannot be undone. Work that may have been sent (it has a dispatch marker) is never resent; when the outcome cannot be proven it ends `unknown`, not retried. A timeout bounds waiting; it does not cancel remote work, nor end a write: state that a write given up on may still change has no other writer until that write ends, so the next writer waits for the write itself, not for the wait on it. A change that can resend or report success without native evidence is a blocking finding.

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
- Wait on observable state or a ready line, not on sleeps or incidental counts. A fake that records state or calls wakes the tests waiting on it when it changes (`changes()` in `tests/support/changes.ts`), and a held step resolves a promise when the code under test reaches it. Find what you wait for by what the action newly created, not by text that was already there. A check that something did not happen asserts once the work that would have done it has ended: after the promise of that call, or, where the code under test should wait on a step the test holds, after `drained()` from `tests/support/drained.ts`. It takes one event-loop turn, so the callbacks queued before it have run, and then fails if Node still lists a real timer, immediate or I/O request as pending, or more handles of a kind (a socket, a child process) than as the fixture started. Node does not list unref'd timers or thread-pool work such as compression, and counts handles only by kind, so code under test that does such work is checked after the promise of its call. A fixture that records when each host call starts and ends also lets a test check the moment after it releases the held step. A decision a call makes before it returns is checked right after it returns. A bare event-loop turn is not the end of anything, so a test waits for one only through `drained()`.
- Do not hide a failure with retries or weaker assertions. Prefer one deterministic race test and one real integration test over many repetitions.
- Isolate inherited environment variables, ports and temporary folders.
- Feed fakes of external programs real captured output and its variations. Unit fakes still share the code's assumptions, so a change in how the plugin talks to Paseo or Claude needs a native simulation scenario.

The test runner bounds every unit test (`--test-timeout` in `package.json`), so a test awaits what it expects directly and a broken one fails at that bound instead of hanging. A test adds no bound of its own to a wait: no timer, no deadline helper wrapped around the call, no count of loop turns. Such a bound duplicates the runner's, fails on a slower machine, and can satisfy an assertion the code under test should have met. Timers in a test belong to the code under test; a test that needs one of its own calls the injected clock (`clock.setTimeout`). The scheduler, the operation worker and the gateway take their timers with the clock (`timers`, beside `now`), and a bounded wait (`bounded()`) runs on the timers of the code that waits; their tests pass `fakeTimers()` from `tests/support/timers.ts`, wait for a timer to be armed through the change signal, and move it on with `tick()`, which runs due callbacks on a later turn as real timers do. A real process a test starts still gets its own time limit (the spawn `timeout`), since the runner fails the test but does not stop the process.

A test stopped at the runner's bound never reaches its own `finally`. So a test turns on fake timers through its context (`t.mock.timers`), which the runner restores, never on the shared `mock` tracker, and registers the cleanup of anything that would outlive the test (a running timer, process or server, a temporary folder) with `t.after()` right after it acquires it. Releasing a promise the test is holding is a step of the test, not cleanup: a pending promise does not keep the process alive.

Lint enforces this in the unit tests (`server/*.test.ts`, `scripts/*.test.ts`, `tests/*.test.mjs`) and their support modules (`tests/support/`). It rejects a real timer with a delay, whatever its callback does, anything from `node:timers` or `node:timers/promises` but `setImmediate`, a wait for an event-loop turn (an immediate, a timer or interval with no delay, `setImmediate` from those modules) outside `tests/support/`, a counted `for` loop that awaits while it also stops on a condition, the shared `mock` tracker's timers, methods, accessors and modules, and an `await` inside a `finally`. A `finally` that must still wait carries a disable comment saying why it is safe. It sees timers called by name or on the global object with a written key, and those modules imported or loaded by a written name. A timer reached through another name, a key built at run time, a deadline helper wrapped around a call, or a `while` loop with its own counter is left to review. The simulation and E2E suites run real processes and keep real time.

## Comments say why

Comments explain why code is the way it is: the host behavior it works around, the race it closes, the version that needs it. A comment that restates the code, or code whose reason is not obvious and has no comment, is a finding.

## Generated and checked files

`server/observer-assets.generated.ts` is generated from `server/observer-source.mjs` by `npm run build:observer`; edit the source, never the generated file. Any edit to the source makes a new observer build, and sessions opened before the update keep running the old one. `server/observer.test.ts` fails until the new build is added to `READABLE_BUILDS`; the build it replaces stays in `compatibleBuilds` in `server/observer.ts` unless the ledger contract changed. Text files use LF line endings on every OS.
