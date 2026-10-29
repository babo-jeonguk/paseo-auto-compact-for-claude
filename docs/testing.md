# Repeatable Linux and Windows simulation

Use **Node 24+**. From this plugin's checkout, install its development dependencies once:

```sh
npm ci --ignore-scripts
```

After each update, run:

```sh
npm run test:update
```

In Windows PowerShell, `npm.cmd run test:update` also works when execution policy blocks `npm.ps1`. Run with **Windows Node** to test Windows; WSL Node tests Linux. The runner records `process.platform`, architecture, OS release, Node/Claude/Paseo versions and product source hashes.

The command runs type checks, the fast regression suite and the native simulation once with Paseo **0.12.0** and once with **0.13.0**. On first use it installs both pinned Paseo toolchains and Claude from `tests/simulation/package-lock.json`. This needs network access and can take several minutes. Later runs reuse them. Nothing is installed globally and no Claude login is required.

## What is real and what is simulated

Each simulation starts stock **Paseo 0.12.0 or 0.13.0**, native **Claude Code 2.1.306**, and this checkout's actual plugin. The client handshake uses the selected toolchain's real version. Only model responses come from a synthetic loopback HTTP server. Native transcript creation, Mod loading, public RPC, settings persistence, process restart and automatic timers run normally. The fixture reports a 500k context to a 1M model so the real 400k threshold can be exercised without sending a huge prompt.

Each run uses temporary HOME/USERPROFILE, Claude settings, Paseo configuration, agents and ports. The native process receives a synthetic API key and a local model URL. Existing Paseo and Claude sessions/settings are not used. Successful runs stop their process trees and delete the temporary home. Failed runs retain the temporary path in `report.json` for diagnosis.

The automatic timer test first verifies real **55- and 50-minute reservation values**, then uses a one-minute idle setting and waits for the real server timer. A second one-minute wait checks that a reservation which elapsed while the plugin was stopped expires on recovery. There is no test-only product RPC and no edit to the plugin's stored reservation times.

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
| Automatic compact | Real timer, native completion and same session; no repeated idle compaction |
| Manual compact | Explicit Compact now completes in the same session |
| Operation identity | Same-ID retries during execution and after completion do not resend; conflicting input is rejected; history remains queryable after new activity |
| Retention | Stop the plugin, age a completed native operation and seed recent/pending controls; reload deletes eligible history and orphan receipts, preserves controls, and does not resend unchanged activity |
| Input overlap | Compaction is cancelled or remains unconfirmed; the user's own response remains on the timeline |
| Changing TTL | New 5m/mixed responses are re-detected; later 1h data restores scheduling |
| Missing TTL | Labeled default retains 50/55-minute scheduling |
| Configuration | Explicit settings work; environment takes priority over merged settings |
| Reload | Settings, conversation OFF and session identity preserved without replay; an in-flight operation recovers through its native receipt and exact command boundary without a second model request |
| Downtime | An already-due reservation expires when the plugin returns |
| Daemon recovery | OFF persists; reopening the same conversation supports a fresh reservation |

Some rows are grouped into one scenario. The fast suite separately covers clock jumps/sleep, late delivery, permissions, model changes, corrupted state, UI status/countdown formatting and negative dispatch cases. It also distinguishes reports delivered into a main turn from queued SDK/user prompts, foreign or completed turns, explicit waiting, and aborted/error turns. A negative runner test verifies that Linux cannot be reported as a Windows execution and unrun scenarios cannot be counted as passed.

The retention scenario deliberately edits only the isolated fixture state while the plugin is stopped; it verifies cleanup through actual startup/RPC and native receipt files, without waiting seven real days. The fast suite covers the exact seven-day boundary, pending protection, bounded batches, deletion/commit failures, restart, clock rollback, receipt directory links and unchanged-activity guards.

This does not measure Anthropic's real cache lifetime, billing savings or summary quality. The default native matrix does not open a browser. The optional browser check below covers the web client; Electron/mobile rendering remains outside that check. Passing controlled input-overlap cases does not prove every possible race in Paseo's public send API is eliminated.

## Install and upgrade E2E

`npm run test:e2e` installs the released plugin from GitHub with the real `paseo` CLI, updates it to the ref under test, runs every scenario above against that install, then rolls back and forward again. It runs unchanged on Linux and Windows. See [tests/e2e/README.md](../tests/e2e/README.md).

On 2026-10-29, at `1a6ceb4` (product code as `6927f9d`), it passed **24/24 on each of four runs**: Linux x64 (WSL2, Node 24.21.0) and Windows 11 build 26100 (Node 24.22.1, MinGit 2.56.0), each with Paseo 0.12.0 and 0.13.0 and Claude Code 2.1.306. Each run installed v1.0.2 (`6dfdb98`) and then this branch from GitHub, sent 39 synthetic model requests and no other connection, and had no plugin stderr. After the rollback, v1.0.2 read the state, kept the conversation OFF and showed both compacted activities as completed; updating again restored their history as `legacy` operations, without a model request. Two earlier rounds of these runs failed only on expectations in the new rollback checks, which were then corrected. The first round, at `48a354f` before the state stayed at version 1, also passed 24/24 on all four, with v1.0.2 refusing the state after rollback. On a heavily loaded Linux host, Paseo's own plugin start limit (about 40 seconds) was hit twice in earlier runs, by v1.0.2 and by this version alike; normal starts took 8–22 seconds there and 8–18 seconds on Windows.

`npm run test:e2e:desktop` installs the ref under test from GitHub into the released Paseo desktop app, whose daemon runs the plugin on the app's Electron 44.2.0 runtime (Node 24.20.0); see [tests/e2e/README.md](../tests/e2e/README.md#desktop-app). It passed **9/9 on each of four runs** (Linux under Xvfb at `1a6ceb4`, Windows 11 at `6927f9d`, the same product code; desktop apps 0.12.0 and 0.13.0), with no plugin stderr and no app update downloaded, as it had at `48a354f`. Earlier runs on the loaded host showed the app's own "local server failed to start" screen once or twice per run, and one Retry each time recovered it; the final runs showed none. Those runs also found that closing the window stops the desktop daemon by default, which the plugin then recovers from, and that a tick in flight at plugin cleanup logged "Daemon client closed"; the plugin no longer reports errors after its cleanup starts.

`npm run test:e2e:android` runs the released Paseo **Android** app in a fresh Android 14 emulator, connected by direct connection to an isolated daemon with this branch installed from GitHub; see [tests/e2e/README.md](../tests/e2e/README.md#android-app). Paseo sends the plugin's client bundle to the app, so its pill, sheet, confirmation and polling run natively on Hermes, including the operation-ID fallback browsers never take. With the 0.12.0 and 0.13.0 APKs it passed **8/8 each** at `1a6ceb4`, as it had at `0d0ab31`: Skip and Undo, a confirmed Compact now whose operation ID the device generated (one model request), the last result in the sheet, and the same result after force-stopping and reopening the app, with no plugin stderr. Building it found two app behaviors the harness now handles: a selected conversation takes about ten seconds to show its pill on the emulator, and Paseo 0.12 briefly restores the last conversation after a restart before moving to a new chat. On a heavily loaded host the emulator's own watchdog stopped it twice ("detected a hanging thread"); those runs did not reach the plugin. At `1a6ceb4`, one 0.12.0 run at load average 12–16 timed out waiting for the pill, which its final screenshot shows rendered; the rerun at lower load passed.

## Optional browser validation

`tests/simulation/browser.mjs` opens the packaged Paseo web client in a real Chromium browser against an isolated native daemon and the loopback model. It checks Skip, Undo, manual compact confirmation and recovery of the completed result after reloading the conversation. Browser validation is separate from the default native matrix and CI jobs.

Provide an existing Playwright Core module and Chromium executable explicitly; this runner does not install browser dependencies:

```sh
node --no-maglev tests/simulation/browser.mjs --paseo 0.12.0 \
  --playwright /absolute/path/to/playwright-core/index.mjs \
  --browser /absolute/path/to/chromium \
  --report-dir /absolute/path/to/results
```

Repeat with `--paseo 0.13.0`. Each run writes a browser report and completed-state screenshot under `browser-<version>/`. An unavailable Windows runtime or browser is an untested environment, not a passing result; WSL execution reports Linux.

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
```

The first command runs both versions. The version-specific commands accept `--claude /absolute/native/claude`, `--tools /npm/prefix`, or `--report-dir /results`. A custom tools prefix may contain the matching ordinary `@getpaseo/cli` package or the versioned aliases used by this repository. Overrides still use an isolated home and the local model server. `npm run test:simulation:0.12 -- --help` lists the options.

To change a tested Claude/Paseo version, edit its exact alias in `tests/simulation/package.json`, regenerate the lockfile with `npm install --prefix tests/simulation --ignore-scripts`, and run the full suite on both OSes. Commit both package and lockfile. Keep 0.12 in the matrix while it remains the declared minimum. Do not infer native compatibility from the unit suite alone.

## CI

[Check workflow](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/main/.github/workflows/check.yml) has Paseo 0.12/0.13 native simulation jobs on **ubuntu-latest** and **windows-latest**, in addition to fast SDK 0.12/0.13 checks on Linux, macOS and Windows. Pull requests, pushes and manual workflow dispatch run them and upload their reports/logs even when a test fails. No API secret is needed. [View workflow runs](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/actions/workflows/check.yml). Native macOS execution is not covered by the fast macOS checks.

## Validation checkpoint — 2026-10-28

The seven-day retention implementation passed `npm run check` (127 tests, TypeScript and embedded-observer consistency). GPT-6.1 Terra ran the expanded native suite on Linux x64 with Node 24.21.0 and Claude Code 2.1.306: Paseo 0.12.0 and 0.13.0 each passed all 18 scenarios. Both versions also passed four web UI checks in Chromium 149: Skip, Undo, confirmed manual compact, and completed-result display after conversation reload. The reports' product and harness fingerprints match the validated checkout.

The expanded retention check exposed loss of native activity identity after compaction. The gateway now preserves the matching compaction revision without recreating an ordinary scheduling window; a fresh request after history cleanup returns the existing-activity guard and sends nothing.

Windows native execution was not available in this environment: WSL interop failed with `UtilBindVsockAnyPort:317: socket failed 1`. Windows CI execution, Electron/mobile rendering and live Anthropic behavior are not established by these results.

## Validation checkpoint — 2026-10-29

After a review, `6927f9d` removed the root causes it found. Outcomes now separate faults from refusals and record whether anything was sent. Job attempt fields are derived from operations. The automatic policy is shared. Client IDs follow input. Migration is tested against a state file generated by v1.0.2's own code. The state stays at version 1, so rollback works. `npm run check` passed 135 tests. The native suite passed 18/18 on Linux with Paseo 0.12.0 and 0.13.0. The Chromium web UI checks passed 4/4 on both versions. The install/upgrade/rollback, desktop and Android E2E results are recorded above. CI passed on Linux, macOS and Windows. Sonnet 5.5 subagents ran every suite.
