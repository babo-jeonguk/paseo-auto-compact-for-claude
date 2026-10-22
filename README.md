# Auto Compact for Claude

Automatically compact large, idle Claude conversations in Paseo before their prompt cache expires. Summarizing while the history is still cached leaves less uncached input to process when you return, which can reduce usage and response delays. [How this helps](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation).

![Compaction countdown and conversation controls](assets/conversations.png)

*Paseo web app with sample data.*

## Why this exists

Claude Code [added idle auto-compaction](https://github.com/anthropics/claude-code/releases/tag/v2.1.299) to summarize large conversations before cache expiry. Paseo does not yet use this feature. This plugin fills that gap **until Paseo supports it natively**.

Codex subscription sessions do not need this plugin: [caches are retained indefinitely for logged-in Codex users](https://x.com/thsottiaux/status/2112712984644784534).

## Requirements

- **Paseo 0.12 or later**. The current execution path is tested on Linux and Windows with isolated native sessions; macOS needs native verification. [Test scope](docs/testing.md).
- A Claude provider using a native Claude Code CLI that supports Mods. Tested with CLI **2.1.306**. Claude profiles are supported too.
- Paseo web app. Native mobile apps are unverified.

Supported Claude versions and setup help: [troubleshooting](docs/runtime.md).

## Install

On the machine running Paseo:

```sh
paseo plugin install /absolute/path/to/paseo-auto-compact-for-claude
```

Enable it in **Settings → Plugins**, then start a Claude conversation. After a reply finishes, open the pill beside the message composer to see its schedule or why it is waiting.

The plugin adds a Claude Mod when a session opens and sends `/compact` through Paseo. Start or reopen a session after installation. [Setup and compatibility](docs/runtime.md).

## Use

The conversation pill is available even below the token threshold.

The pill uses five states:

| Label | Meaning |
| --- | --- |
| **Compact off** | Automatic compaction is disabled. Open the pill to see which setting controls it. |
| **Compact on** | Automation is enabled and waiting for scheduling conditions. A previous cancellation, expiry, skip or success does not turn it off. |
| **Compact in …** | A current reservation has a countdown. New messages cancel that reservation. |
| **Compacting…** | Compaction is running; wait before sending a message. |
| **Check compact** | Open the pill for the problem and next action, such as checking the conversation, reopening the session or correcting settings. |

Open the pill for the current reason and any action needed. Cache TTL and exact reservation times are omitted. Brief refreshes and setting changes use a loading indicator; a persistent refresh failure needs attention. Pending input reported for at least a minute after a reply ended while the conversation is otherwise idle also needs attention; it is not proof that the input has been lost.

- **Automation switch:** enable or disable automatic compaction for this conversation.
- **Skip this time:** cancel the current reservation without changing automation settings. The button stays visible and is disabled when there is no eligible schedule.
- **Undo skip:** restore the original scheduled time while the reservation is still valid. New activity or an expired deadline prevents undo.
- **Compact now:** compact after confirmation, regardless of the automatic token threshold or whether context usage is available. Keep the conversation idle and stop background work first.

Near a scheduled time, skip or turn automation off and wait for confirmation before sending new work. During **Compacting…**, wait for completion.

Open **Settings** from the pill to change the host-wide defaults: **automation on, 200,000 tokens, 55 minutes after a reply finishes**, with all Claude providers enabled. [View settings](assets/settings.png).

Automatic compaction uses TTL metadata from the session transcript, then explicit Claude settings. If TTL is unavailable, scheduling stays enabled using a one-hour assumption. A known five-minute window cannot cover a 55-minute delay. Installing or updating does not schedule old conversations; expired reservations are not replayed. Compaction consumes tokens and may lose detail; cache hits and savings are not guaranteed.

## Remove

Turn automation off in Settings, then remove the plugin:

```sh
paseo plugin remove auto-compact-for-claude
```

Reopen remaining sessions when convenient to unload the observer. Upgrading from an older version that changed the launch command: see [migration](docs/runtime.md#upgrading-from-the-previous-execution-path).

[Setup and troubleshooting](docs/runtime.md) · [Development](docs/development.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Maintainers: run `npm run test:update` after changes. [Repeatable Linux/Windows simulation](docs/testing.md).
