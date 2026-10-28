# Setup and troubleshooting

## Compatibility

Requires **Paseo 0.12 or later** and a Claude provider whose configured executable supports [Claude Code Mods](https://code.claude.com/docs/en/plugins/mods/overview). The current path is tested on Linux with Paseo **0.12.0 and 0.13.0**, native Claude Code **2.1.306**, and SDK **0.3.246**, using isolated CLI daemons and a synthetic model. CI runs the same two versions on Windows; Paseo 0.12 was also verified there before this matrix update. The plugin remains compiled against the 0.12 SDK as its minimum API contract; CI also type-checks it against the 0.13 SDK. See [repeatable simulation and its scope](testing.md). macOS native execution, Electron/browser rendering and native mobile apps are unverified by this simulation. Earlier bridge-based OS test results do not establish support for this implementation.

The default SDK-bundled executable may not support Mods. Select a compatible native Claude executable in the provider's settings if necessary. Disabled hooks, a managed policy, or a CLI that cannot load the observer leave automatic compaction unavailable.

## Session setup

When an interactive Claude session opens, the plugin adds its observer Mod to that session's `CLAUDE_CODE_PLUGIN_DIRS`, preserving other plugin paths and provider environment values. It does not change the configured Claude command. Start or reopen the session after installing or updating the plugin; a running process cannot load a new observer retroactively. History-only sessions are unchanged.

Paseo's public `send('/compact')` starts compaction. The observer records native activity and compaction completion in small local files. It neither launches Claude nor forwards its input/output. A main turn consumes the batch of inputs submitted before it starts, including combined background-task notifications. Completion notifications and peer reports delivered into the active main turn are not counted as queued input. User prompts waiting for a later turn remain pending, even when submitted over the running turn. Child turns and compact commands do not consume pending main-session input.

## Conversation status

The pill uses **Compact off**, **Compact on**, **Compact in …**, **Compacting…**, and **Check compact**. Open it for the current reason and next action. It does not display cache TTL or exact scheduled times.

**Compact on** means automation is enabled, including while context is below the threshold, a reply/input/permission request is pending, or a previous reservation ended. A cancelled, expired, skipped or completed reservation does not turn automation off or imply a new reservation exists. A countdown requires known context at or above the threshold and a future usable reservation.

**Check compact** covers failed or uncertain compaction, unreadable settings, a missing observer, an idle delay too long for the available window, and persistent status-refresh failures. The explanation distinguishes checking the conversation, reopening a compatible session, choosing a shorter delay, or refreshing the connection. Pending input still reported at least one minute after a reply ended, while Paseo is idle with no observed active turns or permission request, also asks the user to check the conversation. This indicates inconsistent activity information, not proof that input was lost.

Brief refreshes and setting changes show a loading indicator without another status label. A stale countdown is hidden. Compaction still in progress takes priority over changes to automation settings.

## Scheduling and recovery

Only observed native ordinary completion creates a reservation. Installation, updates and historical messages do not create new reservations. Turn-ended lifecycle history is not used: Paseo 0.13 leaves that payload empty, while 0.12 supplied a snapshot. A native activity identity works on both versions and prevents a later compact command or delayed host completion from rescheduling the same work. A reply to a background-task notification is new native activity and earns its own reservation, even without a new user message. Future reservations created by this implementation survive reload; elapsed reservations expire on restart. Delivery has up to five minutes of grace, bounded by the cache deadline. A missed cache window expires instead of replaying after sleep.

Before sending, the plugin checks context size, settings, the session and activity identities, idle state, native activity, expiry and cache evidence again. A native guard on the `/compact` command checks the request before summarization. Completion requires both a new compaction boundary on the public request's own turn and the observer's matching native completion record. Claude Team and Enterprise accounts load an organization policy plugin that skips user plugins' classic hooks, including PreCompact and PostCompact. In those sessions the observer records completion when Claude's live context window resets after the command returns. If the window does not reset within 10 seconds, the observer records a failure. An unrelated user turn or a simple return from `send` cannot establish success.

### Cache evidence

The observer captures the actual main-session transcript path from Claude's Stop hook. The server reads a bounded tail with standard file APIs, extracting cache-write TTL metadata without saving message content. A reported one-hour write supports 50- and 55-minute reservations even when the response also contains cache reads. A mixed 5-minute/one-hour write uses the shorter window. Old context before a compaction and other sessions/models do not supply TTL evidence.

If the transcript has no usable TTL data, the plugin uses Claude's explicit environment/settings policy. If neither is available, it **assumes one hour and keeps normal scheduling enabled**, following the subscription-oriented idle-compactor references. TTL metadata stays internal; the controls explain only a resulting scheduling obstacle and the action needed. The fallback is a scheduling assumption, not a measured cache lifetime: an account actually using a five-minute default can compact cold when no metadata reveals it. The plugin does not change your Claude TTL setting or shorten your chosen idle delay.

The request timestamp starts the cache clock; response completion starts the user-selected idle delay. A known five-minute window cannot cover a 50-minute delay. Expired windows and a changed session/model cancel old work. Delayed heartbeats do not reset the cache clock or manufacture a new deadline. Actual cache retention, savings and summary quality are not measured by the local integration fixture.

### Input overlap

Near a scheduled time, skip or turn automation off and wait for confirmation before sending new work. During **Compacting…**, wait for completion. The public API does not atomically check idle and send: input arriving between the last check and dispatch can still be interrupted. Native rejection happens after that host action. The countdown and controls reduce exposure but cannot eliminate it.

Paseo can also report a user's turn complete before its response arrives when input overlaps compaction. This plugin checks native activity rather than trusting that early idle state, marks ambiguous compact results unknown, and does not retry them. It does not change Paseo's completion reporting to other callers.

**Undo skip** restores the original deadline without changing automation settings. New activity, a changed session or delay, expiry, and an attempted operation prevent restoration. **Compact now** ignores the global, provider and conversation automation switches and the automatic token threshold, and does not require context usage data. It persists an operation separately from the reservation and acknowledges it without waiting for Claude to finish. New controls generate the request ID before submission and reuse it after an unconfirmed response; the server returns the existing operation for identical input and rejects conflicting reuse. The controls query that operation by ID and rediscover active/latest outcomes when reopened. New conversation activity does not erase the operation result. A transport error means submission is unconfirmed, not that compaction failed. Closing the controls does not cancel the operation. It may run outside the automatic cache window; keep the conversation idle first.

## Upgrading from the previous execution path

Older versions could replace the Claude launch command. Before retiring that installation, restore the original command in Paseo's provider settings using the old version's restoration facility or its saved command receipt. Do not remove files still referenced by a configured command or running session. This version does not acquire or restore command ownership and has no runtime setup RPC.

Pending reservations from that previous path expire during migration; session off choices, settings, completed history and explicit skip records are retained. A fresh observed ordinary reply is needed before this implementation schedules work.

## Operation storage and recovery

State v2 retains `jobs` as the scheduling and compatibility projection and stores manual and automatic execution history in a separate `operations` array. Startup migrates v1 records, preserving existing manual IDs, session-off choices and skip receipts. Older interrupted operations without dispatch evidence become `unknown`. Unknown schema versions or invalid state fail closed; do not downgrade to an older plugin against a newer state file.

Requests are saved before acknowledgement. A startup/periodic worker claims queued work, rechecks the session and policy, and persists a marker before sending. Work without a send marker can resume after restart; work with that marker is only observed and is never automatically resent. One ID identifies the operation, native observer request and Paseo message. The worker requires matching native completion plus that command's completed timeline boundary to recover success. Reopen already-running conversations after updating to load the observer that writes durable receipts; older compatible observers still support live execution but cannot provide the new recovery evidence.

The operation has a fixed three-minute deadline, also limited by the original automatic delivery window. The send attempt waits up to 30 seconds, live preparation/dispatch/observation up to two minutes, and cleanup up to one additional second. Timeout does not prove non-delivery or cancel a remote command. Periodic reconciliation continues evidence checks until the overall deadline, then preserves an ambiguous sent outcome as `unknown`; an unsent request expires. Pre-send inspection failures have a three-attempt retry budget with backoff. A failed result write is retried locally; after restart, the worker uses durable evidence instead. Temporary state-store failure prevents new dispatch while the unresolved operation remains recorded.

The state file assumes a single writer. Recovery leases and atomic rename do not provide a multi-process transaction or a power-loss durability guarantee. Timeline recovery inspects a bounded page of 200 entries; missing evidence never authorizes a resend. Terminal operation history and its native receipts are kept for at least seven days after the final state update. Pending operations are never deleted by retention.

The new RPC fields are additive: older controls may omit the request ID and native target, but cannot recover a lost acknowledgement by a caller-known ID. New controls retain unconfirmed submission input across closing/reopening within the same application process. That local input is not persisted across an application restart; accepted operations remain discoverable from the server. Existing request IDs are resolved before live settings/session checks. IDs are scoped to this plugin's state file, and a different ID for an already-attempted native activity returns the existing outcome instead of sending again.

## History retention

Cleanup runs at startup and hourly, including while automation is disabled or the host is disconnected. A terminal record becomes eligible seven days after the later of its creation and final update; reading it or retrying its ID does not extend that window. Each pass handles at most 100 expired operations; a remaining backlog or receipt deletion failure is retried on the next timer tick. There is no count-based early eviction of younger records.

The scheduler removes each native receipt before committing removal of its operation. If deleting the receipt fails, its operation remains queryable. If the state commit fails, the operation also remains and cleanup repeats safely. Orphan sweeps run only after that commit, protect every retained operation, and remove at most 100 orphan receipt files per pass. Terminal orphan age uses `observedAt`; empty or partial orphan files use filesystem age. Failures can extend storage beyond seven days. A current observer writes each unchanged terminal receipt once; late writes from older already-open observers can recreate a file, which later sweeps collect without restoring an operation.

After removal, querying the operation returns `null`; ID deduplication and conflict detection are guaranteed only while its record is retained. Clients must use a fresh UUID for a new intent, and must not interpret a missing old record as proof that nothing was sent. The last reservation retains a minimal activity guard and status so unchanged activity cannot be compacted again after history expires. Its operation ID and detailed result are removed; new native activity replaces that projection. Conversation-off choices and skip policy are not history and are preserved. The live observer ledger also retains its latest native state under the existing launch-pruning policy; this seven-day rule applies to the operation collection and per-operation receipt files, not all session metadata. This is a wall-clock policy, not a hard storage-size bound or a multi-process cleanup protocol.

## Data

Settings, reservations and observer files live under `PASEO_HOME` (default `~/.paseo`). The observer stores identifiers, activity times, request policy, transcript path, derived TTL metadata and operation outcomes, not prompts, replies or credentials. It reads a bounded part of the existing Claude transcript to extract usage metadata; it does not copy the transcript into its own files. When a conversation's session opens, launch-local observer files from its earlier sessions are removed once they are closed or have been inactive for a day. Per-operation completion receipts are retained separately for recovery. It reads neither provider authentication nor other plugins' runtime registries. Claude continues sending content to its configured provider as usual.
