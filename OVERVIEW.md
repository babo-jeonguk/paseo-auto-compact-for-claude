Auto Compact for Claude summarizes large, idle conversations while their history is still cached. When you return after a break, Claude processes a short summary instead of the entire expired history, which can reduce usage and response delays. A pill beside the message composer shows the countdown and controls for automation, skip, undo and manual compaction.

Defaults are **200,000 tokens** and **55 minutes after a reply finishes**. Global settings control the threshold, delay and enabled Claude providers. Conversation controls remain available below the threshold, and scheduling continues while the conversation view is not open.

Requires **Paseo 0.12 or later**, a Claude provider using a **native Claude Code CLI with Mods support**, and the Paseo web app. Start or reopen a Claude conversation after installing or updating the plugin.

When the cache lifetime is unavailable, the plugin assumes one hour. A known five-minute cache window cannot cover the default delay. Installing or updating does not schedule existing conversations retroactively. Compaction consumes tokens and can lose detail; savings are not guaranteed.

Settings and reservations are stored locally. Claude continues sending conversation content to its configured provider. Native mobile apps are unverified.

This plugin fills the gap until Paseo natively supports Claude Code's idle auto-compaction. Codex subscription sessions already retain cache indefinitely and are outside its scope. See the [README](README.md) for sources, setup and usage.
