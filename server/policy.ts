import type { Settings } from "../shared/settings";
import type { Observation } from "./model";

// This is a delivery grace period, never a claim about the provider cache TTL.
export const DELIVERY_WINDOW_MS = 5 * 60_000;

export const dueAt = (endedAt: number, settings: Settings) =>
  endedAt + settings.idleMinutes * 60_000;

export type AutomaticBlock = "late" | "off" | "early" | "ineligible";

// The one automatic compaction policy. The scheduler asks before reserving and
// the worker asks again just before sending, so both always apply the same rules.
// Without `agent` only timing and the switches are checked.
export function automaticBlock(input: {
  agentId: string; endedAt: number; settings: Settings; disabled: readonly string[]; now: number;
  agent?: Observation;
}): AutomaticBlock | null {
  const { agentId, endedAt, settings, disabled, now, agent } = input;
  const due = dueAt(endedAt, settings);
  if (now > due + DELIVERY_WINDOW_MS) return "late";
  if (!settings.enabled || disabled.includes(agentId)) return "off";
  if (now < due) return "early";
  if (agent && (!agent.eligible || settings.disabledProviders.includes(agent.provider) || !agent.idle ||
      agent.tokens === null || agent.tokens < settings.threshold)) return "ineligible";
  return null;
}
