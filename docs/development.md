# Development

Clone the public plugin repository, then use Node 24+ from its directory:

```sh
git clone https://github.com/babo-jeonguk/paseo-auto-compact-for-claude.git
cd paseo-auto-compact-for-claude
npm ci --ignore-scripts
npm run build:observer
npm run check
```

`check` verifies the embedded observer source, TypeScript, scheduling, file persistence, conversation controls and execution tests, then runs `lint`. `lint` runs ESLint over the code, tests and suites, with type information for the TypeScript files (`.mjs` files and the `.mts` fixture generator get the rules that need none); `eslint.config.mjs` states why each rule it turns off or adjusts is set that way. It fails on any warning. Inline configuration is off: a directive comment (`eslint-disable`, `/* eslint … */`, `/* global … */`) has no effect and is reported, and every TypeScript directive (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `@ts-check`) is rejected. A file that is the boundary for a rule, such as `server/deadline.ts` with the one real `Timers` implementation, is a file entry in `eslint.config.mjs` that exempts only that selector, keeps every other rule for the file and names the standard it implements. Project rules enforce standards from `CODING_STANDARDS.md` mechanically: no real-time timers, waits for a bare event-loop turn, turn-counting waits, shared-tracker mocks, cleanup awaited in a `finally`, or temporary folders, test hooks and child processes outside the test's cleanup scope in unit tests, named constants for timer delays in product code, and no real time in server code but through the injected timers; each message names the standard. Run `build:observer` after changing `server/observer-source.mjs`. The fast CI matrix runs `check`, lint included, on Linux, macOS and Windows against each Paseo SDK version listed in `.github/workflows/check.yml`; lint reads the types, so each SDK version is linted too. The package pins SDK 0.16.2, the minimum host, as its compile-time contract. Separate native simulation jobs exercise real Claude with each Paseo version in that workflow's simulation matrix on Linux and Windows.

The `Paseo release` workflow checks npm every day at 18:00 KST. The first beta or release of a Paseo line newer than the newest `@getpaseo/cli` in `tests/simulation/package.json` opens one `paseo-release` issue for that line, mentioning the repository owner; later betas of the line and its `.0` release are comments on that issue, and patch releases are ignored. The baseline is the simulation, not the SDK pin, because the pin stays at the 0.16.2 minimum contract. The pull request that adds the line to the simulation closes the issue. `node --import tsx scripts/watch-paseo-release.ts --dry-run` prints what it would post.

## Execution

`index.server.ts` adds the Claude observer to interactive sessions. `server/observer.ts` prepares session-local Mod files and validates observations. `server/observer-source.mjs` uses official Claude Mod events to record native activity, request times, effective TTL policy, the actual Stop-hook transcript path and compaction completion. `server/cache.ts` reads a bounded transcript tail and resolves observed, configured or assumed TTL without making missing metadata a blanket scheduling gate. `server/gateway.ts` sends `/compact` through Paseo's public interface, correlates the message's turn and requires native completion. `server/scheduler.ts` owns reservations and skip/undo. `server/policy.ts` holds the automatic compaction rules that the scheduler applies when reserving and the worker applies again before sending. `server/operations.ts` owns durable operation execution, ownership checkpoints and reconciliation using the scheduler's serialized state transactions. `server/retention.ts` coordinates terminal history removal with observer receipt deletion under that same queue, preserving the last activity guard. `server/deadline.ts` holds the operation deadlines and external-wait timeouts (send, observation, per-read, send call, live observation, cleanup) and bounds external waits without treating timeout as cancellation, handing a failure that arrives after a wait ended to the owner of the work; its `createLifetime` gives the scheduler and the worker one lifetime each, which `stop()` ends and every one of their waits takes. `server/queue.ts` is the one serial queue (plain and keyed: the state queue, the gateway's per-conversation turn, the observer's file writers), and `server/group.ts` the one task group for work in flight that must later be waited for (durable writes, an observation pass); both give each caller its own work's outcome and are self-contained, with no imports. `server/durable.ts` gives every durable file write (the state file, native requests and the active-launch manifest) one lifetime: the plugin's cleanup closes it, so no write starts and no unissued rename is published, then waits for the writes already started. `server/state-changes.ts` decides which conversations a save changed for a screen and pushes the state-changed subscription's events; the cached store in `server/store.ts`, which every save passes through, hands it each save and the state it replaced. `server/report.ts` decides which errors reach the log, cause by cause for a group of them: a defect at once, the host not answering only if the plugin is still running a grace period later, since Paseo closes the plugin's API before calling its cleanup, and the plugin's own stop never; after cleanup begins, a defect of work already issued is logged once. Operation IDs are reused through the native observer and Paseo message; receipt-based recovery never resends work with a dispatch marker.

## Background work

Background work follows what needs attention, not the number of conversations. A turn end observes only that conversation. Every ten seconds the scheduler reads, one by one, only the conversations that hold a reservation or a pending operation; Paseo's agent listing has no ID filter, so this pass lists nothing. Once a minute it lists every agent as a safety net for missed events. Each conversation's read in a pass is bounded on its own: a slow or failing read misses only that conversation, every other result is applied, and the first failure is then reported. A listing page that fails or times out still fails the whole scan, which is retried at the next minute. Observations are applied in one state transaction per batch. Reads happen outside it and can commit out of order, so per conversation the most recently started read wins, and a lower native revision of the same launch is ignored. A pass whose host read times out keeps observation single-flight until that read ends, for at most one minute. A status read records the reply it sees, so the controls do not wait for a scan. `server/gateway.ts` applies the basic eligibility checks before reading a native ledger, and `createCachedStore` in `server/store.ts` serves state reads from memory until the plugin's own next write. A failed write keeps the previous snapshot, and a failed read clears it. The ten-second scheduler tick and the five-second observer heartbeat are unchanged.

On the client, `client/cadence.ts` holds the polling decisions as pure functions and `client/clock.ts` one timer shared by every mounted control. `client/state-events.ts` subscribes a surface to the plugin's state changes and decides which of its queries a change makes it read again; for each such query a read still in flight is left to finish, since a plugin request cannot be stopped, and the changes heard meanwhile share one read of that query after it. `client/settings-list.ts` builds the Settings screen's list query, which reads at the status safety cadence only while its subscription is not live or its last read failed. A conversation's status follows host events and the plugin's state changes, with a ten-second safety poll while the app is visible. After three consecutive failures, shared by every control of that conversation, the poll backs off to 30 seconds, and it stops while the app is hidden (`AppState`; react-native-web maps document visibility onto it). The countdown re-renders when its label changes, once a minute until its last minute. Compact now's operation is read again with its conversation's status on each state change, and looked up at the status safety cadence until it ends, or for 30 seconds if no record appears. Directory discovery runs on mount, visibility, reconnect and directory events, with a five-minute safety refresh. A status poll that recovers after failures counts as a reconnect, which also refreshes mounted conversation status and resets its backoff.

| Steady state | Before | After |
|---|---|---|
| Session status requests per visible conversation pill | 30/min | 6/min (2/min after failures, none while hidden) |
| Timer renders per pill | 60/min, one timer each | 1/min in a minute countdown, 60 in the last minute, none otherwise; one timer in total |
| Directory listings | 2/min | 0.2/min plus host events |
| Full agent listings by the daemon | 6/min plus one per turn end | 1/min; a turn end reads one agent |
| Per-conversation reads between full scans | none (each pass listed every agent) | one per conversation with a reservation or pending operation, every ten seconds |
| Native ledger reads per periodic pass | every listed agent | eligible agents with a reservation or pending operation, or every eligible agent once a minute |
| State file reads per observation batch | one per observed agent | one, served from memory between writes |
| Operation lookups while the controls track a pending operation | 30/min | 6/min (2/min after failures), plus one per change to its conversation |

Provider commands, process launchers, IPC sockets and other plugins' runtime inventories are outside this package. See [execution limits and migration](runtime.md).

## Local installation

From this checkout, install the development directory on an isolated test daemon:

```sh
paseo plugin install .
```

After editing installed files, run `paseo plugin reload auto-compact-for-claude`. Existing Claude sessions need to reopen to load a changed observer; their provider command is preserved. For ordinary use, follow the [GitHub installation instructions](../README.md#install).

## Packaging and releases

```sh
npm pack --dry-run --ignore-scripts
npm pack
```

The package includes the client, server, embedded observer, documentation and screenshots. Keep public links and assets within this directory. `prepack` rebuilds the observer and runs checks. `npm pack` writes a versioned `.tgz` into the current directory.

Distribution uses the public GitHub repository and GitHub Releases. `private: true` prevents accidental npm publication; it does not restrict the public Git repository or installation through Paseo. Release versions in `package.json` and `package-lock.json` must agree, and Git tags use the `v` prefix. A specific published tag can be selected with the install command's `--ref` option.

Text files use LF line endings on every OS. Keep `.gitattributes` in the checkout: the embedded observer's source hash and generated-file check must remain identical on Windows.

During an edit, run the relevant test first, then `npm run test:update` (the fast observer, TypeScript, unit and lint checks):

```sh
npm run test:focused -- server/cache.test.ts
npm run test:update
```

`npm test` and `test:focused` fail any unit test that runs longer than 60 seconds, so a broken wait fails instead of hanging. The product's waits run on injected timers that unit tests drive, so a unit test that starts no real process takes under a second. One that does (git, the scripts under test, the cleanup scope's own checks, one of which waits out a short runner bound) is bounded by its processes' own time limits; the rest of the bound is room for slow CI runners. A test stopped at the bound skips its own `finally` but still runs its `t.after()` hooks, which is why cleanup is registered with the test's cleanup scope, whose one hook releases everything the test acquired. A real timer such a test leaves running keeps the process alive after the failure is printed, until that timer ends or, for one that repeats, the CI job's time limit.

Both scripts load TypeScript through `tests/support/loader.mjs`, which turns off tsx's compile cache. tsx writes that cache asynchronously inside the test process after compiling a file it has not seen, which `drained()` reports as pending work; with the cache off, the first run after an edit and every CI run behave like any other. `tests/loader.test.mjs` runs a `drained()` test on a fresh temp directory to keep it that way.

After committing, use a disposable detached worktree for native validation. The runner records the exact commit and keeps results in `test-results/snapshots/<sha>-<timestamp>/`. Editing or pushing your original checkout does not change the files being tested.

```sh
npm run test:snapshot -- --suite simulation --paseo 0.16.2
npm run test:release
```

`test:release` runs the fast checks and the complete native version matrix against one committed snapshot. It requires Git, installed root dependencies and simulation tools (`npm ci --prefix tests/simulation --ignore-scripts`). Dependency links are reused only with matching lockfiles; no global tools are installed. The source checkout must be clean at launch. Use `--ref <commit>` to test an older revision with matching lockfiles. Failed tests still write `snapshot.json`; cleanup errors fail the command too.

CI runs every fast SDK/OS check and every native version/OS combination. PR updates cancel the previous run of that PR; only `main` pushes start push workflows, avoiding duplicate push/PR runs on feature branches. Native versions have separate jobs and artifact names, so a failed version can be rerun on its own. A main run is allowed to finish to preserve evidence for that commit.

Local native runs share one machine slot across worktrees and fail immediately if it is occupied. This prevents this project's daemons from competing with each other. It does not control other projects or detect unrelated machine load. Normal completion releases the slot; after a crash or failed cleanup, inspect the PID in the reported lock directory, stop only your own surviving test processes, and remove the lock only once they are gone. CI runners have separate slots.

These commands do not run the install/rollback and desktop/Android E2E in `tests/e2e` (see its README). When wiring those harnesses into the snapshot runner, pin their GitHub install target to the snapshot's full SHA, use their `--min 1` mode for routine install checks (the native matrix retains real timers), and share the native slot with desktop/emulator runs. Keep full install/rollback and app checks in the release checklist. See [simulation setup, coverage and reports](testing.md).

## Reference-driven validation

TTL collection follows the transcript approach in [claude-cache](https://github.com/the-cybersapien/claude-cache/blob/5b038ace690d74060f01d19b9b1f7e253914e151/hooks/register.tsx#L85-L103). Timer lifecycle and SDK differences were compared with [davidar/claude-idle-compact](https://github.com/davidar/claude-idle-compact/tree/35ec925345acfce26bc0ba260c1f611dceab1148) and [intenex/claude-idle-compactor](https://github.com/intenex/claude-idle-compactor/tree/fdd49d222a3bcea6a1fffc85d72199dad3aacd7c). The product keeps public Paseo dispatch; the references' terminal-only direct compact calls do not establish SDK safety.

The public `tests/simulation/` fixture checks actual native transcript metadata, real 50/55-minute reservation values, shortened real automatic timers, same-session completion, input overlap and recovery. Missing, five-minute, mixed, settings and environment TTL cases run through native Claude too. These use a synthetic loopback model; they do not measure Anthropic's cache or claim a real 55-minute warm-cache run.
