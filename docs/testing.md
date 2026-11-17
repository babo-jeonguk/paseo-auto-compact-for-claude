# Repeatable Linux and Windows simulation

Use **Node 24+**. From this plugin's checkout, install its development dependencies once:

```sh
npm ci --ignore-scripts
```

During development, run the fast checks after each update:

```sh
npm run test:update
```

In Windows PowerShell, `npm.cmd run test:update` also works when execution policy blocks `npm.ps1`. Run with **Windows Node** to test Windows; WSL Node tests Linux. The runner records `process.platform`, architecture, OS release, Node/Claude/Paseo versions and product source hashes.

The update command runs observer consistency, type checks and the fast regression suite. After committing, run `npm run test:release` for those checks and the full native matrix on an isolated snapshot with Paseo **0.12.0**, **0.13.0**, **0.14.0** and **0.15.0**. Install the pinned native tools once with `npm ci --prefix tests/simulation --ignore-scripts`. This needs network access and can take several minutes; later runs reuse them. Nothing is installed globally and no Claude login is required.

## What is real and what is simulated

Each simulation starts stock **Paseo 0.12.0, 0.13.0, 0.14.0, 0.15.0 or 0.16.0**, native **Claude Code 2.1.306**, and this checkout's actual plugin. The client handshake uses the selected toolchain's real version. Only model responses come from a synthetic loopback HTTP server. Native transcript creation, Mod loading, public RPC, settings persistence, process restart and automatic timers run normally. The fixture reports a 500k context to a 1M model so the real 400k threshold can be exercised without sending a huge prompt.

Each run uses temporary HOME/USERPROFILE, Claude settings, Paseo configuration, agents and ports. The native process receives a synthetic API key and a local model URL. Existing Paseo and Claude sessions/settings are not used. Successful runs stop their process trees and delete the temporary home. Failed runs retain the temporary path in `report.json` for diagnosis.

The automatic timer test first verifies real **55- and 50-minute reservation values**, then uses a one-minute idle setting and waits for the real server timer. A second one-minute wait checks that a reservation which elapsed while the plugin was stopped expires on recovery. There is no test-only product RPC and no edit to the plugin's stored reservation times.

## Paseo 0.15 restart and browser reconnect checks

The preview keeps the default development SDK at 0.12.0 and tests all four pinned versions in the SDK and native matrices. The focused restart/reconnect suite can use the beta alias installed by the native tools above, or a separate CLI directory:

```sh
npm install --prefix /tmp/auto-compact-paseo-015 --ignore-scripts --no-audit --no-fund @getpaseo/cli@0.15.0
node --no-maglev tests/simulation/restart-reconnect.mjs \
  --tools /tmp/auto-compact-paseo-015 \
  --browser /absolute/path/to/chromium
```

The suite checks completed-request deduplication after restart, interrupted compaction after graceful and forced shutdown, automatic recovery of a running ordinary turn after forced shutdown, actual `addHook` registration by an installed probe plugin, and rendered countdown/progress recovery after a browser connection outage. It uses a local forwarding proxy to disconnect only the browser while the daemon state changes, then reconnects the same document without reloading it. Model responses alone are synthetic.

Use `--suite interrupted|recovery|hooks|browser|restart` to narrow a run and `--report-dir /path/to/results` to preserve separate attempts. Reports include product/test source hashes, request counts, conversation/operation evidence, and browser screenshots. Temporary homes are retained for inspection. The forced-shutdown checks currently require Linux; a Windows invocation must not be reported as equivalent graceful/forced coverage. Desktop Electron and mobile reconnection are separate tests.

`--suite graceful-recovery` separately asserts that a running ordinary Claude turn is automatically resumed after the official `paseo daemon stop` command. In the initial Linux beta investigation this expectation failed: the running record became closed with `resumeOnStartup: false`, and no resume prompt reached the model. This diagnostic is separate from testing the plugin's protection against duplicate compaction and false success. The interrupted-compaction tests inspect the saved recovery eligibility and send an ordinary user message when the host did not retain an automatic recovery candidate.

On a heavily loaded machine, `--minimal-builtins` omits the released server's list of unrelated bundled provider/usage plugins through a test-only module loader. It does not replace the server, plugin runtime, native Claude, or web UI. The report explicitly records this mode and the loader hash. Results in this mode do not establish coexistence with the complete default bundled-plugin set; keep stock-default results separate.

## Covered behavior

| Area | Check |
| --- | --- |
| TTL acquisition | Actual native transcript → observed one-hour TTL → 55-minute reservation |
| Settings | 50-minute delay preserved; context threshold gates automatic dispatch while manual compaction works below it |
| Policies | Global, provider and per-conversation switches act independently |
| Skip/Undo | Original due time restored; stale undo rejected after new input |
| New input | Busy state suppresses old work; completed input earns a new reservation |
| Background agents | Two completion notifications can share one main turn without leaving phantom pending input; that turn earns a new reservation without a new user message |
| In-turn delivery | A background command completes during the main turn; the native transcript confirms absorption and automatic scheduling remains available |
| Background shell | A background shell outlives an explicit compaction; its completion notification arrives as a new turn, leaves no phantom input or active turn and earns a new reservation without a second `/compact` |
| Automatic compact | Real timer, native completion and same session; no repeated idle compaction |
| Manual compact | Explicit Compact now completes in the same session |
| Operation identity | Same-ID retries during execution and after completion do not resend; conflicting input is rejected; history remains queryable after new activity |
| Retention | Stop the plugin, age a completed native operation and seed recent/pending controls; reload deletes eligible history and orphan receipts, preserves controls, and does not resend unchanged activity |
| Input overlap | Compaction is cancelled or remains unconfirmed; the user's own response remains on the timeline |
| Changing TTL | New 5m/mixed responses are re-detected; later 1h data restores scheduling |
| Missing TTL | Labeled default retains 50/55-minute scheduling |
| Configuration | Explicit settings work; environment takes priority over merged settings |
| Reload | Settings, conversation OFF and session identity preserved without replay; an in-flight operation recovers through its native receipt and exact command boundary without a second model request |
| Concurrent conversations | Two conversations compact at the same time; each operation's receipt and completed command boundary stay with its own conversation, a second request for a held conversation returns the existing operation, and each native session is unchanged |
| Downtime | An already-due reservation expires when the plugin returns |
| Daemon recovery | OFF persists; reopening the same conversation supports a fresh reservation |

Some rows are grouped into one scenario. The fast suite separately covers clock jumps/sleep, late delivery, permissions, model changes, corrupted state, UI status/countdown formatting and negative dispatch cases. It also distinguishes reports delivered into a main turn from queued SDK/user prompts, foreign or completed turns, explicit waiting, and aborted/error turns. A negative runner test verifies that Linux cannot be reported as a Windows execution and unrun scenarios cannot be counted as passed.

The retention scenario deliberately edits only the isolated fixture state while the plugin is stopped; it verifies cleanup through actual startup/RPC and native receipt files, without waiting seven real days. The fast suite covers the exact seven-day boundary, pending protection, bounded batches, deletion/commit failures, restart, clock rollback, receipt directory links and unchanged-activity guards.

This does not measure Anthropic's real cache lifetime, billing savings or summary quality. The default native matrix does not open a browser. The optional browser check below covers the web client; Electron/mobile rendering remains outside that check. Passing controlled input-overlap cases does not prove every possible race in Paseo's public send API is eliminated.

## Install and upgrade E2E

`npm run test:e2e` installs the released plugin from GitHub with the real `paseo` CLI, updates it to the ref under test, runs every scenario above against that install, then rolls back and forward again. It runs unchanged on Linux and Windows. See [tests/e2e/README.md](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/main/tests/e2e/README.md).

`npm run test:e2e:desktop` installs the ref under test from GitHub into the released Paseo desktop app, whose daemon runs the plugin on the app's Electron 44.2.0 runtime (Node 24.20.0); see [tests/e2e/README.md](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/main/tests/e2e/README.md#desktop-app). Closing the window stops the desktop daemon by default; the plugin recovers when it starts again.

`npm run test:e2e:android` runs the released Paseo **Android** app in a fresh Android 14 emulator, connected by direct connection to an isolated daemon with this branch installed from GitHub; see [tests/e2e/README.md](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/main/tests/e2e/README.md#android-app). Paseo sends the plugin's client bundle to the app, so its pill, sheet, confirmation and polling run natively on Hermes, including the operation-ID fallback browsers never take. With the 0.12.0 and 0.13.0 APKs it passed **8/8 each** at `1a6ceb4`, as it had at `0d0ab31`: Skip and Undo, a confirmed Compact now whose operation ID the device generated (one model request), the last result in the sheet, and the same result after force-stopping and reopening the app, with no plugin stderr. Building it found two app behaviors the harness now handles: a selected conversation takes about ten seconds to show its pill on the emulator, and Paseo 0.12 briefly restores the last conversation after a restart before moving to a new chat. On a heavily loaded host the emulator's own watchdog stopped it twice ("detected a hanging thread"); those runs did not reach the plugin. At `1a6ceb4`, one 0.12.0 run at load average 12–16 timed out waiting for the pill, which its final screenshot shows rendered; the rerun at lower load passed.

## Optional browser validation

`tests/simulation/browser.mjs` opens the packaged Paseo web client in a real Chromium browser against an isolated native daemon and the loopback model. It checks Skip, Undo, manual compact confirmation and recovery of the completed result after reloading the conversation. Browser validation is separate from the default native matrix and CI jobs.

Provide an existing Playwright Core module and Chromium executable explicitly; this runner does not install browser dependencies:

```sh
node --no-maglev tests/simulation/browser.mjs --paseo 0.12.0 \
  --playwright /absolute/path/to/playwright-core/index.mjs \
  --browser /absolute/path/to/chromium \
  --report-dir /absolute/path/to/results
```

Repeat with `--paseo 0.13.0`, `--paseo 0.14.0` or `--paseo 0.16.0`. Each run writes a browser report and completed-state screenshot under `browser-<version>/`. An unavailable Windows runtime or browser is an untested environment, not a passing result; WSL execution reports Linux.

## Paseo 0.14 lifecycle regression

The focused 0.14 harness covers the two upstream lifecycle changes separately from the default matrix:

```sh
node --no-maglev tests/simulation/lifecycle.mjs reload
node --no-maglev tests/simulation/lifecycle.mjs automatic
node --no-maglev tests/simulation/lifecycle.mjs cleanup
```

`reload` verifies that Compact now sends nothing after a plugin reload until an ordinary message reopens the observer, and then succeeds once. `automatic` applies the same assertion to a real one-minute reservation and normal scheduler tick. `cleanup` runs Paseo 0.14's installed idle collector with only its clock and sweep interval accelerated, then verifies closure, reservation invalidation and ordinary-message resume. It does not establish the real one-hour wait, successful compaction before cleanup, input/background-work vetoes, or a cleanup/dispatch race. These diagnostics use native Claude and the loopback model, need localhost binding, and are not part of the cross-platform CI matrix.

## Reports and failure handling

Results are written under `test-results/<platform>-<arch>/paseo-<version>/`:

- `report.json`: OS/version/source fingerprints, per-scenario pass/fail/duration, model-request metadata, failure state and retained temporary path.
- `junit.xml`: CI-compatible failures and explicit not-run cases.
- `daemon-1.log`, `daemon-2.log`: initial daemon and restart diagnostics.

The command exits nonzero for failed setup, a failed scenario, OS mismatch or failed cleanup. It never turns missing tools or unsupported native execution into a pass. Report files are ignored by Git and excluded from npm packages. Save a run's directory elsewhere if you want to compare multiple runs locally.

## Options and version updates

Run only the native simulation:

```sh
npm run test:simulation
npm run test:simulation:0.12 -- --expect-platform linux
npm run test:simulation:0.13 -- --expect-platform win32
npm run test:simulation:0.14 -- --expect-platform linux
```

The first command runs every version in the matrix, 0.12.0 through 0.16.0. The version-specific commands accept `--claude /absolute/native/claude`, `--tools /npm/prefix`, or `--report-dir /results`. A custom tools prefix may contain the matching ordinary `@getpaseo/cli` package or the versioned aliases used by this repository. Overrides still use an isolated home and the local model server. `npm run test:simulation:0.12 -- --help` lists the options.

To change a tested Claude/Paseo version, edit its exact alias in `tests/simulation/package.json`, regenerate the lockfile with `npm install --prefix tests/simulation --ignore-scripts`, and run the full suite on both OSes. Commit both package and lockfile. Keep 0.12 in the matrix while it remains the declared minimum. Do not infer native compatibility from the unit suite alone.

## CI

[Check workflow](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/main/.github/workflows/check.yml) has Paseo 0.12 through 0.16 native simulation jobs on **ubuntu-latest** and **windows-latest**, in addition to fast SDK 0.12 through 0.16 checks on Linux, macOS and Windows. Pull requests, main-branch pushes and manual workflow dispatch run them and upload their reports/logs even when a test fails. No API secret is needed. [View workflow runs](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/actions/workflows/check.yml). Native macOS execution is not covered by the fast macOS checks.

## Fast feedback and isolated runs

`npm run test:focused -- server/cache.test.ts` runs just the named test file. `npm run test:update` runs only the fast checks; it no longer starts native daemons. `npm run test:release` explicitly runs the fast checks and the full native matrix from one committed snapshot.

For one native version, run `npm run test:snapshot -- --suite simulation --paseo 0.13.0`. Reports include the full commit SHA in `snapshot.json` and native `report.json`, under `test-results/snapshots/<sha>-<timestamp>/`. Source edits and later pushes do not change that run. Root and simulation dependencies must be installed for the chosen lockfiles. See [development workflow](development.md#packaging-and-releases) for prerequisites and cleanup.

CI separates native versions into independent Linux/Windows jobs and artifacts. An open PR no longer also starts a feature-branch push workflow; a new PR commit cancels its superseded PR run. Manual dispatch can select a feature branch if it needs validation before a PR exists. Actual automatic-timer and downtime waits remain in each native lane. No retry turns an assertion failure into a pass.
