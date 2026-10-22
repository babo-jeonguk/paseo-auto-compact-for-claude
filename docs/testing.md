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

The command runs type checks, the fast regression suite and the native simulation. On first use it installs the pinned simulation tools from `tests/simulation/package-lock.json`. This needs network access and can take several minutes. Later runs reuse them. Nothing is installed globally and no Claude login is required.

## What is real and what is simulated

The simulation starts stock **Paseo 0.12.0**, native **Claude Code 2.1.306**, and this checkout's actual plugin. Only model responses come from a synthetic loopback HTTP server. Native transcript creation, Mod loading, public RPC, settings persistence, process restart and automatic timers run normally. The fixture reports a 500k context to a 1M model so the real 400k threshold can be exercised without sending a huge prompt.

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
| Background agents | Two completion notifications can share one main turn without leaving phantom pending input |
| In-turn delivery | A background command completes during the main turn; the native transcript confirms absorption and automatic scheduling remains available |
| Automatic compact | Real timer, native completion and same session; no repeated idle compaction |
| Manual compact | Explicit Compact now completes in the same session |
| Input overlap | Compaction is cancelled or remains unconfirmed; the user's own response remains on the timeline |
| Changing TTL | New 5m/mixed responses are re-detected; later 1h data restores scheduling |
| Missing TTL | Labeled default retains 50/55-minute scheduling |
| Configuration | Explicit settings work; environment takes priority over merged settings |
| Reload | Settings, conversation OFF and session identity preserved without replay |
| Downtime | An already-due reservation expires when the plugin returns |
| Daemon recovery | OFF persists; reopening the same conversation supports a fresh reservation |

Some rows are grouped into one scenario. The fast suite separately covers clock jumps/sleep, late delivery, permissions, model changes, corrupted state, UI status/countdown formatting and negative dispatch cases. It also distinguishes reports delivered into a main turn from queued SDK/user prompts, foreign or completed turns, explicit waiting, and aborted/error turns. A negative runner test verifies that Linux cannot be reported as a Windows execution and unrun scenarios cannot be counted as passed.

This does not measure Anthropic's real cache lifetime, billing savings or summary quality. It does not open a browser or verify Electron/mobile UI rendering. Passing controlled input-overlap cases does not prove every possible race in Paseo's public send API is eliminated.

## Reports and failure handling

Results are written under `test-results/<platform>-<arch>/`:

- `report.json`: OS/version/source fingerprints, per-scenario pass/fail/duration, model-request metadata, failure state and retained temporary path.
- `junit.xml`: CI-compatible failures and explicit not-run cases.
- `daemon-1.log`, `daemon-2.log`: initial daemon and restart diagnostics.

The command exits nonzero for failed setup, a failed scenario, OS mismatch or failed cleanup. It never turns missing tools or unsupported native execution into a pass. Report files are ignored by Git and excluded from npm packages. Save a run's directory elsewhere if you want to compare multiple runs locally.

## Options and version updates

Run only the native simulation:

```sh
npm run test:simulation
npm run test:simulation -- --expect-platform linux
npm run test:simulation -- --expect-platform win32
```

Use `--claude /absolute/native/claude`, `--tools /npm/prefix`, or `--report-dir /results` when needed. The tools prefix must contain the Paseo CLI and its dependencies. Overrides still use an isolated home and the local model server. `npm run test:simulation -- --help` lists the options.

To change the tested Claude/Paseo version, edit `tests/simulation/package.json`, regenerate its lockfile with `npm install --prefix tests/simulation --ignore-scripts`, and run the full suite on both OSes. Commit both package and lockfile. Do not infer native compatibility from the unit suite alone.

## CI

[Check workflow](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/blob/main/.github/workflows/check.yml) has native simulation jobs on **ubuntu-latest** and **windows-latest**, in addition to fast checks on Linux, macOS and Windows. Pull requests, pushes and manual workflow dispatch run them and upload their reports/logs even when a test fails. No API secret is needed. [View workflow runs](https://github.com/babo-jeonguk/paseo-auto-compact-for-claude/actions/workflows/check.yml). Native macOS execution is not covered by the fast macOS checks.
