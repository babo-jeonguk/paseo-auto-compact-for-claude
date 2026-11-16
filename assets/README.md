# Interface screenshots

These images show the real Auto Compact client in the stock **Paseo 0.16.0 web app**, captured on **2026-11-17** in the light theme. The declared minimum Paseo support is 0.12; these captures establish the tested version only.

| File | Size | Content |
| --- | --- | --- |
| [conversations.png](conversations.png) | 1440 × 960 | Composer pill countdown (**Compact 55m**) and open controls: context usage, conversation switch, skip, manual compact and Settings. |
| [undo-skip.png](undo-skip.png) | 390 × 1000 | Mobile browser sheet after skipping, showing **Compact on**, disabled **Skip this time**, and **Undo skip**. |
| [settings.png](settings.png) | 1440 × 960 | The plugin's page under Settings → Plugins with the default 200k threshold, 55-minute delay and the Claude provider switch. |

Agents and workspace are disposable test records in an isolated Paseo daemon. The plugin was installed from GitHub and ran against native Claude Code; only the model replies are synthetic, so the conversation text, the 245k context usage and the reservation are sample data, not real user conversations or evidence of billing, cache retention or successful model compaction. The plugin client and host settings UI are real. Native iOS and Android apps remain unverified.
