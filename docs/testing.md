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

The command runs type checks, the fast regression suite and the native simulation once each with Paseo **0.12.0**, **0.13.0** and **0.14.0**. On first use it installs all three pinned Paseo toolchains and Claude from `tests/simulation/package-lock.json`. This needs network access and can take several minutes. Later runs reuse them. Nothing is installed globally and no Claude login is required.

## What is real and what is simulated

Each simulation starts stock **Paseo 0.12.0, 0.13.0 or 0.14.0**, native **Claude Code 2.1.306**, and this checkout's actual plugin. The client handshake uses the selected toolchain's real version. Only model responses come from a synthetic loopback HTTP server. Native transcript creation, Mod loading, public RPC, settings persistence, process restart and automatic timers run normally. The fixture reports a 500k context to a 1M model so the real 400k threshold can be exercised without sending a huge prompt.

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

`npm run test:e2e` installs the released plugin from GitHub with the real `paseo` CLI, updates it to the ref under test, runs every scenario above against that install, then rolls back and forward again. It runs unchanged on Linux and Windows. See [tests/e2e/README.md](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/main/tests/e2e/README.md).

On 2026-10-29, at `1a6ceb4` (product code as `6927f9d`), it passed **24/24 on each of four runs**: Linux x64 (WSL2, Node 24.21.0) and Windows 11 build 26100 (Node 24.22.1, MinGit 2.56.0), each with Paseo 0.12.0 and 0.13.0 and Claude Code 2.1.306. Each run installed v1.0.2 (`6dfdb98`) and then this branch from GitHub, sent 39 synthetic model requests and no other connection, and had no plugin stderr. After the rollback, v1.0.2 read the state, kept the conversation OFF and showed both compacted activities as completed; updating again restored their history as `legacy` operations, without a model request. Two earlier rounds of these runs failed only on expectations in the new rollback checks, which were then corrected. The first round, at `48a354f` before the state stayed at version 1, also passed 24/24 on all four, with v1.0.2 refusing the state after rollback. On a heavily loaded Linux host, Paseo's own plugin start limit (about 40 seconds) was hit twice in earlier runs, by v1.0.2 and by this version alike; normal starts took 8–22 seconds there and 8–18 seconds on Windows.

`npm run test:e2e:desktop` installs the ref under test from GitHub into the released Paseo desktop app, whose daemon runs the plugin on the app's Electron 44.2.0 runtime (Node 24.20.0); see [tests/e2e/README.md](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/main/tests/e2e/README.md#desktop-app). It passed **9/9 on each of four runs** (Linux under Xvfb at `1a6ceb4`, Windows 11 at `6927f9d`, the same product code; desktop apps 0.12.0 and 0.13.0), with no plugin stderr and no app update downloaded, as it had at `48a354f`. Earlier runs on the loaded host showed the app's own "local server failed to start" screen once or twice per run, and one Retry each time recovered it; the final runs showed none. Those runs also found that closing the window stops the desktop daemon by default, which the plugin then recovers from, and that a tick in flight at plugin cleanup logged "Daemon client closed"; the plugin no longer reports errors after its cleanup starts.

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

Repeat with `--paseo 0.13.0` or `--paseo 0.14.0`. Each run writes a browser report and completed-state screenshot under `browser-<version>/`. An unavailable Windows runtime or browser is an untested environment, not a passing result; WSL execution reports Linux.

## Paseo 0.14 lifecycle regression

The focused 0.14 harness covers the two upstream lifecycle changes separately from the default matrix:

```sh
node --no-maglev tests/simulation/lifecycle.mjs reload
node --no-maglev tests/simulation/lifecycle.mjs automatic
node --no-maglev tests/simulation/lifecycle.mjs cleanup
```

`reload` verifies that Compact now sends nothing after a plugin reload until an ordinary message reopens the observer, and then succeeds once. `automatic` applies the same assertion to a real one-minute reservation and normal scheduler tick. `cleanup` runs Paseo 0.14's installed idle collector with only its clock and sweep interval accelerated, then verifies closure, reservation invalidation and ordinary-message resume. It does not establish the real one-hour wait, successful compaction before cleanup, input/background-work vetoes, or a cleanup/dispatch race. These diagnostics use native Claude and the loopback model, need localhost binding, and are not part of the cross-platform CI matrix.

See the pinned [upstream change review](research/paseo-0.14.0-upstream-changes-2026-10-29.md), [project impact and patch rationale](research/paseo-0.14.0-project-impact-2026-10-29.md), and [lifecycle reproduction evidence](research/paseo-0.14.0-lifecycle-reproduction-2026-10-29.md).

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

The first command runs all three versions. The version-specific commands accept `--claude /absolute/native/claude`, `--tools /npm/prefix`, or `--report-dir /results`. A custom tools prefix may contain the matching ordinary `@getpaseo/cli` package or the versioned aliases used by this repository. Overrides still use an isolated home and the local model server. `npm run test:simulation:0.12 -- --help` lists the options.

To change a tested Claude/Paseo version, edit its exact alias in `tests/simulation/package.json`, regenerate the lockfile with `npm install --prefix tests/simulation --ignore-scripts`, and run the full suite on both OSes. Commit both package and lockfile. Keep 0.12 in the matrix while it remains the declared minimum. Do not infer native compatibility from the unit suite alone.

## CI

[Check workflow](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/main/.github/workflows/check.yml) has Paseo 0.12/0.13/0.14 native simulation jobs on **ubuntu-latest** and **windows-latest**, in addition to fast SDK 0.12/0.13/0.14 checks on Linux, macOS and Windows. Pull requests, pushes and manual workflow dispatch run them and upload their reports/logs even when a test fails. No API secret is needed. [View workflow runs](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/actions/workflows/check.yml). Native macOS execution is not covered by the fast macOS checks.

## Validation checkpoint — 2026-10-28

The seven-day retention implementation passed `npm run check` (127 tests, TypeScript and embedded-observer consistency). GPT-6.1 Terra ran the expanded native suite on Linux x64 with Node 24.21.0 and Claude Code 2.1.306: Paseo 0.12.0 and 0.13.0 each passed all 18 scenarios. Both versions also passed four web UI checks in Chromium 149: Skip, Undo, confirmed manual compact, and completed-result display after conversation reload. The reports' product and harness fingerprints match the validated checkout.

The expanded retention check exposed loss of native activity identity after compaction. The gateway now preserves the matching compaction revision without recreating an ordinary scheduling window; a fresh request after history cleanup returns the existing-activity guard and sends nothing.

Windows native execution was not available in this environment: WSL interop failed with `UtilBindVsockAnyPort:317: socket failed 1`. Windows CI execution, Electron/mobile rendering and live Anthropic behavior are not established by these results.

## Validation checkpoint — 2026-10-29

After a review, `6927f9d` removed the root causes it found. Outcomes now separate faults from refusals and record whether anything was sent. Job attempt fields are derived from operations. The automatic policy is shared. Client IDs follow input. Migration is tested against a state file generated by v1.0.2's own code. The state stays at version 1, so rollback works. `npm run check` passed 135 tests. The native suite passed 18/18 on Linux with Paseo 0.12.0 and 0.13.0. The Chromium web UI checks passed 4/4 on both versions. The install/upgrade/rollback, desktop and Android E2E results are recorded above. CI passed on Linux, macOS and Windows. Sonnet 5.5 subagents ran every suite.

## Paseo 0.14 validation checkpoint — 2026-10-29

The initial SDK 0.12.0, 0.13.0 and 0.14.0 lanes each passed `npm run check` with 136 tests. At compatibility checkpoint `abdbb2f`, 146 tests passed on all three SDKs across Linux, macOS and Windows CI; workflow runs `40934131828` and `40934141757` also passed the 18/18 native matrix on Linux and Windows for every version with Claude Code 2.1.306. The Linux native matrix had passed 18/18 locally as well. GPT-6.1 Terra (High) reproduced the 0.14 reload evidence split before the fix, then passed the focused manual reload, automatic due-dispatch and accelerated idle-cleanup scenarios after the fix. The reload guards sent no `/compact` until an ordinary message installed the new observer; cleanup invalidated the old reservation and resumed with a fresh one. macOS native execution remains unverified. Subsequent commits must rely on their own PR checks rather than this pinned checkpoint.

## Validation checkpoint — 2026-10-30

A second review led to `6d45a44`:
- Deadlines now follow the phase: send-by, then observation from the dispatch marker.
- Unreadable observers or settings are faults, not readings.
- Every pre-send read is bounded.
- Identity, schemas, translations, notices and E2E helpers each live in one place.

`996f8c6` fixed how the desktop E2E counted startup retries.

Results:
- `npm run check`: 144 tests passed. The gateway tests passed five runs in a row at load average 19–23, where they had failed intermittently before.
- Linux, Paseo 0.12.0 and 0.13.0:
  - native suite 18/18;
  - Chromium web UI 4/4;
  - install/upgrade/rollback E2E 24/24;
  - desktop E2E 9/9.
- Windows 11, both versions:
  - install/upgrade/rollback E2E 24/24;
  - desktop E2E 9/9.
- Android 14 with the 0.12.0 and 0.13.0 APKs: 8/8.

Reruns, none of them plugin assertions:
- Under load average about 25, three earlier runs timed out on daemon readiness and one on plugin init. The first native run and the first Windows install/upgrade runs were among them.
- The Windows desktop runs failed until the retry fix. They passed at `996f8c6` with no startup retries.
- One Android 0.12.0 attempt stalled during an emulator cold boot that dismissed 18 ANR dialogs.

Sonnet 5.5 subagents ran every suite.

## Validation checkpoint — 2026-10-30, after the third and fourth reviews

The third review led to `343cfa5`. It classifies an error before the dispatch marker in one place, bounds retries by the send deadline alone, and admits a compaction natively until its observation can end. It also stops a stopped scheduler from writing, and makes unreadable settings keep a reservation. `9c74f9f` gave Compact now a 10-second send deadline. `e7b8d70` logs the host being unavailable only if the plugin is still running 30 seconds later. The Paseo 0.14 support from PR #3 was merged in between. The fourth review then led to `70cb123` and `2c27f50`:
- Whether a session must resume after a plugin reload is part of the observed conversation, read everywhere from there.
- When nothing was sent, the reason is shown.
- Only the fault that ends a request is logged.
- Finished operations retire their native request.
- Compact now answers an activity's history before its live checks.

Results at `2c27f50` unless noted:
- `npm run check`: 161 tests passed.
- Linux, Paseo 0.14.0, 0.13.0 and 0.12.0:
  - native suite 18/18;
  - Chromium web UI 4/4;
  - install/upgrade/rollback E2E 24/24;
  - desktop E2E 9/9.
- Linux, Paseo 0.14 lifecycle: `reload`, `automatic` and `cleanup` passed. Right after a plugin reload, Compact now was refused with the resume reason and sent nothing. After an ordinary message, it compacted once.
- Windows 11, all three versions:
  - install/upgrade/rollback E2E 24/24;
  - desktop E2E 9/9 at `70cb123`.
- Android 14 with the 0.14.0, 0.13.0 and 0.12.0 APKs: 8/8 at `70cb123`.

`2c27f50` only reorders Compact now's checks, which the desktop and Android flows do not reach.

On Paseo 0.14 the install E2E updates the plugin, which reloads it. The reservation made before the update is then held as `blocked` until an ordinary message resumes the session, and that message earns a new reservation. At `70cb123` the Windows 0.14 install E2E failed there: a second Compact now of an already compacted activity returned the resume refusal instead of the existing outcome. `2c27f50` fixed it.

At `e7b8d70` the 0.12.0 desktop E2E no longer logged an error on app quit, which it had done twice in a row at `343cfa5`.

Reruns, none of them plugin assertions: one Android 0.12.0 run, after host load from other projects reached 89 while it ran.

Sonnet 5.5 subagents ran every suite.
