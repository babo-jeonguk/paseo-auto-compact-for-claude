import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

/** A boundary can arrive after the next ordinary input was admitted. The command,
 * not a boundary elsewhere in the full snapshot, identifies a compact-only turn. */
export function isCompactCommandTurn(
  timeline: PluginLifecycleEvents["agent.turn_ended"]["timeline"]
): boolean {
  const lastUser = timeline.findLastIndex(
    (item) => item.type === "user_message"
  );
  const user = timeline[lastUser];
  if (user?.type === "user_message")
    return /^\/compact(?:\s|$)/.test(user.text.trim());
  return timeline.some((item) => item.type === "compaction");
}
