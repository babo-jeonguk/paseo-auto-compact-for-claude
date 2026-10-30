# Paseo 0.14 lifecycle reproduction, 2026-10-29

Before the fix, the manual reload-first scenario reproduced a plugin operation tracking defect. After the fix, the native reload and cleanup scenarios passed. Cleanup followed by an ordinary prompt exercised the actual Paseo cleanup collector and plugin lifecycle. The automatic due-dispatch variant also passed after the fix.

Both use the public plugin submodule, pinned Paseo 0.14.0, native Claude Code 2.1.306, Node 24 on Linux, and the isolated synthetic loopback model. No paid model is used. Run from `paseo-auto-compact-for-claude` with localhost binding available:

```sh
node --no-maglev tests/simulation/lifecycle.mjs reload
node --no-maglev tests/simulation/lifecycle.mjs cleanup
node --no-maglev tests/simulation/lifecycle.mjs automatic
```

Before the fix, the reload command failed because operation state was `observing`, rather than `succeeded`, after 22 seconds. The harness now checks the intended guarded behavior and passes after the fix. An earlier run also remained nonterminal for 60 seconds. The operation deadline is three minutes; its eventual terminal state was not observed. The harness retains isolated logs and prints their temporary directory. It should not be interpreted as a terminal timeout test.

## Reload then Compact now

After one ordinary turn and a scheduled reservation, reload the plugin and immediately request Compact now, with no intervening ordinary prompt. In the observed run the accepted operation targeted the original observer launch and generation. The next prompt was exactly `/compact`: one model request was made, and the native timeline contained one completed manual boundary on the same turn as the operation-ID command. The Claude session ID stayed the same. The old observer closed and the reopened session had a different launch and generation. Its ledger recorded `compact.status = completed`, but `compact.id = null`; the prepared receipt was `{}`. The operation remained `observing`, with no false success and no resend during the 22-second observation window. This is a real successful compaction whose plugin operation could not be correlated. The observation does not prove what happens after the operation deadline.

Ranked, falsifiable explanations and evidence:

1. **Send-triggered stale reopen replaces the observer after prepare.** If so, the operation's prepared launch is the old one, and the send closes it and opens a different one. Both launches and generations were observed, and the operation points at the old one. This is strongly supported.
2. **Scheduler invalidation fails to stop an already accepted operation.** If so, an accepted operation persists while session-open invalidation runs. It remained observing after the new launch; that is consistent, but this experiment does not isolate invalidation as the reason or establish whether cancellation would have been correct after send began.
3. **The new observer sees an unrequested compact.** If so, the boundary completes but its new ledger has `id = null`, while the old prepared receipt is empty. Both were observed, supporting the evidence split.
4. **Cleanup is safer because close invalidates before resume.** If so, closure invalidates the old reservation before a later ordinary turn, and a fresh launch can schedule anew. The cleanup experiment below exercises this path; it does not test a compact operation already in flight.

## Idle cleanup then ordinary prompt

The `cleanup` command loads the installed Paseo 0.14 collector itself through a test-only Node loader. The loader changes only that collector's sweep interval and its injected clock after a marker is created. It leaves the plugin clock, runtime eligibility, provider veto, revalidation, native close and plugin code intact. This avoids waiting an hour. The accelerated time does not simulate wall-clock effects across the rest of Paseo, and the one-hour real-time threshold is not independently tested here. The marker is removed after closure before resuming.

The collector logged `Collected idle agent runtime`; the old observer ledger was closed. The old scheduled job was persisted as `skipped` with detail `Activity or session state changed`, and the session row disappeared while the agent was closed. A later ordinary prompt reopens the same native session with a new observer launch and generation, makes one model request and creates a fresh scheduled reservation with a different revision. The row API is the available server-side eligibility signal; a rendered UI pill was not exercised. Compact-as-first-prompt, successful compaction immediately before cleanup, input/background-work vetoes and a cleanup/dispatch race were not tested.

The files under `tests/simulation` are test-only. This cleanup reproduction phase did not modify production plugin behavior. The later reload guard is described under post-fix validation below. The first acceleration attempt did not reliably advance time past a collector protection reset; the final loader advances the collector clock continuously after the marker so the eligibility and protection checks remain real.

The diagnostic run passed end to end. A later diagnostic-free attempt timed out starting the daemon at 90 seconds; a retry with a longer startup allowance passed the complete cleanup scenario, including the persisted-job assertion and continuously accelerated clock. Startup under load made that retry substantially slower than the lifecycle itself.

## Post-fix validation

The same `node --no-maglev tests/simulation/lifecycle.mjs reload` command now passes against the fixed plugin. Immediately after plugin reload, Compact now returned an operation that reached `failed` with code `failed_before_dispatch` and the message `Session must resume after plugin reload; send a message before compacting`. There were zero model requests, no `/compact` command, no compaction boundary, and no receipt. An idempotent repeat of the same operation remained failed and sent nothing. The original observer launch, generation and native session were unchanged at that point.

The next ordinary prompt made one model request and reopened the same native session on a different launch and generation. A new Compact now operation then succeeded with exactly one additional model request, exactly one `/compact` command and one completed manual boundary on that command's turn. Its completed receipt matched the operation ID, the new launch, generation and native session. An idempotent repeat remained succeeded without another request. This verifies the intended manual refusal and recovery.

The post-fix `node --no-maglev tests/simulation/lifecycle.mjs cleanup` also passed unchanged. The actual 0.14 collector closed the runtime, the persisted old reservation became skipped, the observer closed and the row was absent. An ordinary prompt resumed the same native session with a different launch and generation, made one model request and produced a fresh scheduled reservation. As above, the collector-only clock is accelerated; the real one-hour wait and a rendered pill remain untested.

## Post-fix automatic due dispatch

`node --no-maglev tests/simulation/lifecycle.mjs automatic` passed using the real one-minute idle delay and normal ten-second scheduler tick. After the ordinary reservation and plugin reload, the harness called the public session-row RPC to attach the new plugin instance to its host, then waited past the actual due time. The persisted job and visible row both became `blocked` with `Session must resume after plugin reload; send a message before compacting`. The scheduler created no operation, made zero model requests, and produced no `/compact` command, compaction boundary or native receipt. A subsequent ordinary prompt made one model request, reopened the same native session on a new observer launch and generation, and created a fresh scheduled reservation.

An initial attempt without the session-row RPC left the newly loaded plugin host disconnected, so the scheduler did not dispatch; that attempt was interrupted and its isolated daemon was stopped. The passing test exercises the connected-host path and does not use the accelerated cleanup loader.
