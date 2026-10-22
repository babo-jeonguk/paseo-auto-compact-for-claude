Auto Compact for Claude summarizes large, idle conversations while their history is still cached. When you return after a break, Claude processes a short summary instead of the entire expired history, which can reduce usage and response delays. A pill beside the message composer shows the countdown and controls for automation, skip, undo and manual compaction.

Defaults are **200,000 tokens** and **55 minutes after a reply finishes**. Global settings control the threshold, delay and enabled Claude providers. Conversation controls remain available below the threshold, and scheduling continues while the conversation view is not open.

Requires **Paseo 0.12 or later** and a Claude provider using a **native Claude Code CLI with Mods support**. The current execution path is tested on Linux and Windows with native Claude Code 2.1.306 and a synthetic model; macOS needs native verification. [Test scope](docs/testing.md). The plugin adds a Claude Mod to new sessions and sends `/compact` through Paseo. Start or reopen a session after installation.

The plugin reads TTL metadata from the session transcript or uses explicit Claude settings. When neither is available, it keeps scheduling enabled using a one-hour assumption. A known five-minute window cannot cover a 55-minute delay. Installation and updates do not schedule old conversations, and expired reservations are not replayed. Compaction consumes tokens and can lose detail; savings are not guaranteed.

Settings and reservations are stored locally. Claude continues sending conversation content to its configured provider. Native mobile apps are unverified.

This plugin fills the gap until Paseo natively supports Claude Code's idle auto-compaction. Codex subscription sessions already retain cache indefinitely and are outside its scope. See the [README](README.md) for sources, setup and usage.
