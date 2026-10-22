import type { Row } from "../shared/rpc";
import type { Settings } from "../shared/settings";
import { formatTokenThreshold } from "./format";

export const sessionKey = (hostId: string, agentId: string) =>
  ["auto-compact", hostId, "session", agentId] as const;

export interface Presentation {
  label: "Compact off" | "Compact on" | "Compacting…" | "Check compact" | `Compact in ${number}${"m" | "s"}`;
  description: string;
}

export const STATUS_GRACE_MS = 10_000;
export const INPUT_IDLE_GRACE_MS = 60_000;

export function canUndoSkip(row: Row, now: number): boolean {
  return row.status === "skipped" && !!row.revision && !!row.undoSkip && row.undoSkip.dueAt > now;
}

const on = (description: string): Presentation => ({ label: "Compact on", description });
const check = (description: string): Presentation => ({ label: "Check compact", description });

// Describe automation now, rather than preserving a previous reservation's result.
export function sessionPresentation(row: Row, settings: Settings, now: number): Presentation {
  if (row.status === "running") return {
    label: "Compacting…", description: "Wait for compaction to finish before sending a message.",
  };
  if (!settings.enabled) return {
    label: "Compact off", description: "Automatic compaction is off in Settings.",
  };
  if (settings.disabledProviders.includes(row.provider)) return {
    label: "Compact off", description: "Automatic compaction is off for this provider in Settings.",
  };
  if (!row.enabled || row.status === "disabled") return {
    label: "Compact off", description: "Automatic compaction is off for this conversation.",
  };
  if (row.status === "unknown")
    return check("Compaction could not be confirmed. Check the conversation before trying again.");
  if (row.status === "failed")
    return check("Compaction failed. Check the conversation before trying again.");
  if (row.status === "busy") {
    if (row.inputIdleSince != null && now - row.inputIdleSince >= INPUT_IDLE_GRACE_MS)
      return check("Claude still reports pending input after the reply ended. Check the conversation; reopen the session if no work is pending.");
    if (row.busyReason === "permission")
      return on("Resolve the permission request before automatic compaction can be scheduled.");
    if (row.busyReason === "input")
      return on("Waiting for pending input to finish before checking the schedule.");
    return on("A new schedule will be checked after the current reply finishes.");
  }
  if (row.status === "blocked") {
    if (/settings/i.test(row.detail))
      return check("Compact settings could not be read. Open Settings to check them.");
    if (/observer/i.test(row.detail))
      return check("Automatic compaction is unavailable in this session. Reopen the conversation session.");
    if (/exceeds|outside.*cache|delay.*cache/i.test(row.detail))
      return check("The idle delay is too long to compact within the available time. Choose a shorter delay in Settings.");
  }
  if (row.tokens === null)
    return on("Waiting for context usage before checking the schedule.");
  if (row.tokens < settings.threshold)
    return on(`Automatic compaction is scheduled at ${formatTokenThreshold(settings.threshold)} context tokens or more.`);
  if (row.status === "scheduled" && row.dueAt !== null && row.dueAt > now) {
    const remaining = row.dueAt - now;
    const countdown = remaining <= 60_000
      ? `${Math.ceil(remaining / 1000)}s` as const
      : `${Math.ceil(remaining / 60_000)}m` as const;
    return {
      label: `Compact in ${countdown}`,
      description: "Compaction will run if the conversation stays idle. New messages cancel this schedule.",
    };
  }
  if (row.status === "scheduled" && row.dueAt !== null)
    return on("Checking whether the scheduled compaction can start.");
  if (row.status === "skipped" && canUndoSkip(row, now))
    return on("This schedule was skipped. Undo skip to restore it, or continue the conversation to schedule again.");
  if (row.status === "blocked" && /connection|launch/i.test(row.detail))
    return on("Waiting for the conversation to connect before checking the schedule.");
  return on("A new schedule will be checked after the next reply finishes.");
}

// Short reads and mutations use a spinner. Never retain a stale countdown.
export function pendingPresentation(previous: Presentation | null, elapsed: number,
  changing = false): { presentation: Presentation | null; loading: boolean } {
  if (!changing && elapsed >= STATUS_GRACE_MS) return {
    presentation: check("Compact status could not be refreshed. Refresh the status and check the connection."),
    loading: false,
  };
  return {
    presentation: previous ? {
      ...previous,
      label: previous.label.startsWith("Compact in ") ? "Compact on" : previous.label,
      description: changing ? "Updating compact settings…" : "Refreshing compact status…",
    } : null,
    loading: true,
  };
}
