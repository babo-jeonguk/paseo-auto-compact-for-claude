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

## Not covered

- Real model responses, cache lifetime and billing.
- The web UI; `tests/simulation/browser.mjs` covers it on Linux.
- The desktop and mobile apps.
- Connected remote hosts.
