# Setup and troubleshooting

## Compatibility

Requires **Paseo 0.12 or later** and a Claude provider whose configured executable supports [Claude Code Mods](https://code.claude.com/docs/en/plugins/mods/overview). The current path is tested on Linux and Windows with Paseo **0.12.0**, native Claude Code **2.1.306**, and SDK **0.3.246**, using isolated CLI daemons and a synthetic model. See [repeatable simulation and its scope](testing.md). macOS native execution, Electron/browser rendering and native mobile apps are unverified by this simulation. Earlier bridge-based OS test results do not establish support for this implementation.

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

Only observed native ordinary completion creates a reservation. Installation, updates and historical messages do not create new reservations. A native activity identity prevents a later compact command or delayed host completion from rescheduling the same work. A reply to a background-task notification is new native activity and earns its own reservation, even without a new user message. Future reservations created by this implementation survive reload; elapsed reservations expire on restart. Delivery has up to five minutes of grace, bounded by the cache deadline. A missed cache window expires instead of replaying after sleep.

Before sending, the plugin checks context size, settings, the session and activity identities, idle state, native activity, expiry and cache evidence again. A native guard on the `/compact` command checks the request before summarization. Completion requires both a new compaction boundary on the public request's own turn and the observer's matching native completion record. Claude Team and Enterprise accounts load an organization policy plugin that skips user plugins' classic hooks, including PreCompact and PostCompact. In those sessions the observer records completion when Claude's live context window resets after the command returns. If the window does not reset within 10 seconds, the observer records a failure. An unrelated user turn or a simple return from `send` cannot establish success.

### Cache evidence

The observer captures the actual main-session transcript path from Claude's Stop hook. The server reads a bounded tail with standard file APIs, extracting cache-write TTL metadata without saving message content. A reported one-hour write supports 50- and 55-minute reservations even when the response also contains cache reads. A mixed 5-minute/one-hour write uses the shorter window. Old context before a compaction and other sessions/models do not supply TTL evidence.

If the transcript has no usable TTL data, the plugin uses Claude's explicit environment/settings policy. If neither is available, it **assumes one hour and keeps normal scheduling enabled**, following the subscription-oriented idle-compactor references. TTL metadata stays internal; the controls explain only a resulting scheduling obstacle and the action needed. The fallback is a scheduling assumption, not a measured cache lifetime: an account actually using a five-minute default can compact cold when no metadata reveals it. The plugin does not change your Claude TTL setting or shorten your chosen idle delay.

The request timestamp starts the cache clock; response completion starts the user-selected idle delay. A known five-minute window cannot cover a 50-minute delay. Expired windows and a changed session/model cancel old work. Delayed heartbeats do not reset the cache clock or manufacture a new deadline. Actual cache retention, savings and summary quality are not measured by the local integration fixture.

### Input overlap

Near a scheduled time, skip or turn automation off and wait for confirmation before sending new work. During **Compacting…**, wait for completion. The public API does not atomically check idle and send: input arriving between the last check and dispatch can still be interrupted. Native rejection happens after that host action. The countdown and controls reduce exposure but cannot eliminate it.

Paseo can also report a user's turn complete before its response arrives when input overlaps compaction. This plugin checks native activity rather than trusting that early idle state, marks ambiguous compact results unknown, and does not retry them. It does not change Paseo's completion reporting to other callers.

**Undo skip** restores the original deadline without changing automation settings. New activity, a changed session or delay, expiry, and an attempted operation prevent restoration. **Compact now** ignores the global, provider and conversation automation switches and the automatic token threshold, and does not require context usage data. It may run outside the automatic cache window; keep the conversation idle first.

## Upgrading from the previous execution path

Older versions could replace the Claude launch command. Before retiring that installation, restore the original command in Paseo's provider settings using the old version's restoration facility or its saved command receipt. Do not remove files still referenced by a configured command or running session. This version does not acquire or restore command ownership and has no runtime setup RPC.

Pending reservations from that previous path expire during migration; session off choices, settings, completed history and explicit skip records are retained. A fresh observed ordinary reply is needed before this implementation schedules work.

## Data

Settings, reservations and observer files live under `PASEO_HOME` (default `~/.paseo`). The observer stores identifiers, activity times, request policy, transcript path, derived TTL metadata and operation outcomes, not prompts, replies or credentials. It reads a bounded part of the existing Claude transcript to extract usage metadata; it does not copy the transcript into its own files. It reads neither provider authentication nor other plugins' runtime registries. Claude continues sending content to its configured provider as usual.
