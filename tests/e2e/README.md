# End-to-end install and upgrade check

Installs the released plugin from GitHub into an isolated Paseo daemon, updates it to the ref under test, and runs the main features there. Linux and Windows run the same script. Run it by hand before a release or after a Paseo upgrade; it is not part of `npm run check` or CI.

## What is real and what is fake

Real:
- The Paseo daemon and the `paseo` CLI, with their own home and port per run.
- The plugin install and update from GitHub: `paseo plugin install git:… --ref` and `paseo plugin update --ref`.
- Native Claude Code 2.1.306, its transcripts and the observer Mod.
- The plugin's timers, RPCs, settings, `state.json` and observer receipts.

Fake:
- **Model responses.** `tests/simulation/model.mjs` answers on a loopback port, the same as the native simulation.
- **Other outbound traffic.** Claude's proxy points to a local server that refuses and records every connection. The daemon itself still reaches GitHub to install the plugin.

No model request leaves the host and no real account is used.

## Requirements

- Node 24 or later.
- Git on `PATH`. On Windows, portable MinGit is enough.
- Network access to GitHub.
- The pinned tools: `npm ci --prefix tests/simulation --ignore-scripts`.
- The ref under test pushed to GitHub.

## Run

```sh
npm run test:e2e -- --paseo 0.13.0 --to <branch, tag or commit>
```

| Flag | Meaning |
|---|---|
| `--paseo` | `0.12.0` or `0.13.0` (default `0.13.0`) |
| `--from` | Release installed first and rolled back to (default `v1.0.2`) |
| `--to` | Ref under test (default `main`) |
| `--source` | Plugin Git source (default `git:babo-jeonguk/paseo-auto-compact-for-claude`) |
| `--min 1` | Skips the two scenarios that wait for real one-minute deadlines |
| `--claude` | Native Claude binary (default: the pinned one from `tests/simulation`) |
| `--report-dir` | Results directory (default `test-results/e2e`) |

On Windows, run `node.exe --no-maglev tests\e2e\run.mjs …` with Windows Node and the same flags. `--expect-platform win32` makes a run under WSL fail instead of reporting Linux as Windows.

Each run writes `report.json` and the daemon logs to `<report-dir>/<platform>-paseo-<version>/`. The report records the installed revisions, the Claude/Git/Node versions, the synthetic request count and every refused connection. A passing run deletes its temporary home; a failing one keeps it and records its path.

## Checked items

| # | Item |
|---|---|
| 1 | `--from` installs from GitHub at the expected revision and answers its RPCs |
| 2 | `--from` records a real reservation, a conversation OFF and a completed Compact now in state v1 |
| 3 | Update to `--to` at the expected revision: state v2 keeps OFF and the reservation time, turns the earlier compaction into a queryable operation, and a new Compact now of the same activity sends nothing |
| 4 | All native simulation scenarios (`tests/simulation/scenarios.mjs`) against the updated install |
| 5 | Rollback to `--from` leaves `state.json` byte-identical; `--from` refuses state v2 and sends nothing |
| 6 | Update to `--to` again restores operation, without replay |
| 7 | No plugin errors in the daemon log, apart from the rollback refusal |

Item 5 documents a one-way door: v1.0.2 reads only state version 1, so after a rollback automation stops until the newer version returns.

## Desktop app

`tests/e2e/desktop.mjs` runs the released **Paseo desktop app** (Electron) in an isolated home. The app starts its own daemon on its Electron runtime, so the plugin's server code runs there rather than on the system Node. The plugin is installed from GitHub at `--to`, and Playwright drives the app window through the Chrome DevTools protocol. Playwright's `_electron.launch` cannot be used: it adds `--inspect`, which the app's command-line passthrough rejects.

Get the app of the same Paseo version from its [GitHub release](https://github.com/getpaseo/paseo/releases) and extract it; nothing is installed:

| OS | Release asset | `--app` |
|---|---|---|
| Linux x64 | `Paseo-<version>-x64.tar.gz` | the extracted `Paseo-<version>-x64` directory |
| Windows x64 | `Paseo-Setup-<version>-x64.zip` | the directory holding `Paseo.exe` |

```sh
xvfb-run -a -s '-screen 0 1440x900x24' npm run test:e2e:desktop -- --paseo 0.13.0 --app <dir> --to <ref>
```

Linux needs a display; `xvfb-run` provides one. On Windows the app window appears on the desktop for the few minutes of the run. The app uses `PASEO_HOME` for its daemon and `PASEO_ELECTRON_USER_DATA_DIR` for its own data, both temporary, and its daemon is stopped at the end.

The run keeps the app at the version under test and its UI readable:

- **No self-update.** The app checks for, downloads and on Windows installs its own updates. Its Chromium network goes to a second refusing proxy through `PASEO_ELECTRON_FLAGS`; loopback stays direct. The daemon is not proxied, so the GitHub install still works. The report lists the refused app connections, and an item checks that no update was downloaded.
- **English UI.** `--lang=en-US`, so Paseo's own strings match the selectors on a non-English Windows.
- **Startup retry.** The app waits 30 seconds for the daemon it starts. On a slow host it then shows "The local server failed to start" while that daemon is still starting. The run clicks Retry, as a user would, up to three times and records each in `appStartupRetries` with a screenshot.

| # | Item |
|---|---|
| 1 | The app starts a desktop-managed daemon of the requested version, running on the app's Electron executable |
| 2 | The plugin installs from GitHub at `--to` into that daemon |
| 3 | A conversation the desktop daemon starts loads the observer and earns a 55-minute reservation |
| 4 | Skip and Undo in the app window update the daemon |
| 5 | Confirmed Compact now in the app window compacts once in the same session |
| 6 | The window shows the last compaction after reload |
| 7 | Closing the window quits the app and, by the app's default, its daemon; reopening starts a new daemon and shows the last compaction without resending |
| 8 | The app downloaded no update of itself |
| 9 | No plugin errors in the daemon log |

The report adds the Electron and bundled Node versions, the daemon executable and screenshots.

## Android app

`tests/e2e/android.mjs` runs the released **Paseo Android app** in a fresh emulator. The app connects by **Direct connection** to an isolated daemon on this host, where the plugin is installed from GitHub at `--to`. Paseo sends the plugin's client bundle to every connected app, so the plugin's controls run natively there: React Native views on Hermes. That includes the operation-ID fallback in `client/compact-submission.ts`, which browsers never take. uiautomator drives the app; the daemon's state is the evidence.

Requirements:

- An Android SDK with `platform-tools`, `emulator`, `cmdline-tools` and the system image (default `system-images;android-34;google_apis;x86_64`), plus hardware acceleration (KVM on Linux).
- The APK of the same Paseo version from its [GitHub release](https://github.com/getpaseo/paseo/releases): `paseo-v<version>-android.apk`.

```sh
npm run test:e2e:android -- --paseo 0.13.0 --apk paseo-v0.13.0-android.apk --to <ref>
```

The run creates its own AVD under `--avd-home` (a temporary directory by default) and leaves other AVDs alone. It wipes its data on every boot and stops the emulator at the end. `adb reverse` maps the device's `127.0.0.1:<port>` to the daemon, so no password, relay or network setup is needed. The emulator needs about 2 GB of memory. On a heavily loaded host its own watchdog may stop it ("detected a hanging thread"); the run then fails at that step and should be repeated when the host is quieter. The emulator sometimes reports its System UI as not responding; the run taps Wait and counts these in `anrDismissed`.

| # | Item |
|---|---|
| 1 | The plugin installs from GitHub at `--to`, and a conversation earns a 55-minute reservation |
| 2 | The app of the requested version installs and connects to the daemon by direct connection |
| 3 | The plugin pill renders natively with the reservation countdown |
| 4 | Skip and Undo in the native sheet update the daemon |
| 5 | Confirmed Compact now on the device compacts once, with an operation ID the device generated |
| 6 | The sheet shows the last compaction |
| 7 | Force-stopping and reopening the app shows the last result and sends nothing |
| 8 | No plugin errors in the daemon log |

The report records the Android, app and emulator versions, and the screenshots.

## Not covered

- Real model responses, cache lifetime and billing.
- The web UI; `tests/simulation/browser.mjs` covers it on Linux.
- iOS.
- Connected remote hosts.
