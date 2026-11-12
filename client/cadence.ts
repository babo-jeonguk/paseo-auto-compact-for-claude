export const SESSION_POLL_MS = 10_000; // safety poll while the surface is active
export const SESSION_BACKOFF_MS = 30_000; // after SESSION_BACKOFF_FAILURES consecutive failures
export const SESSION_BACKOFF_FAILURES = 3;
export const OPERATION_POLL_MS = 2_000; // operation lookup while the popover is open
export const OPERATION_LOOKUP_MS = 30_000; // bound for an operation that is never found
export const DIRECTORY_REFRESH_MS = 5 * 60_000; // directory safety refresh
export const POLL_JITTER_MS = 5_000;
// Fresh across one missed poll plus network jitter.
export const STATUS_FRESH_MS = 2 * SESSION_POLL_MS + POLL_JITTER_MS;

export type PollEvent = "success" | "failure" | "focus" | "reconnect";

export function pollFailures(previous: number, event: PollEvent): number {
  return event === "failure" ? previous + 1 : 0;
}

export function sessionPollDelay(input: { active: boolean; failures: number }): number | false {
  if (!input.active) return false;
  return input.failures >= SESSION_BACKOFF_FAILURES ? SESSION_BACKOFF_MS : SESSION_POLL_MS;
}

export function operationPollDelay(input: {
  active: boolean; found: boolean; pending: boolean; elapsed: number;
}): number | false {
  if (!input.active) return false;
  if (input.found && !input.pending) return false;
  if (!input.found && input.elapsed >= OPERATION_LOOKUP_MS) return false;
  return OPERATION_POLL_MS;
}

export function countdownTickDelay(remaining: number | null): number | null {
  if (remaining === null || remaining <= 0) return null;
  return remaining > 60_000
    ? ((remaining - 1) % 60_000) + 1
    : ((remaining - 1) % 1_000) + 1;
}

export function nextRenderAt(input: {
  now: number; dueAt?: number | null; deadlines?: ReadonlyArray<number | null | undefined>;
}): number | null {
  const { now, dueAt, deadlines = [] } = input;
  const times: number[] = [];
  if (dueAt !== null && dueAt !== undefined && dueAt > now) {
    const tick = countdownTickDelay(dueAt - now);
    if (tick !== null) times.push(now + tick);
  }
  for (const deadline of deadlines)
    if (deadline !== null && deadline !== undefined && deadline > now) times.push(deadline);
  return times.length ? Math.min(...times) : null;
}

export type DirectoryTrigger = "mount" | "reconnect" | "visible" | "agents-changed" | "interval";

export function directoryRefreshDelay(input: { trigger: DirectoryTrigger; active: boolean }): number | false {
  if (!input.active) return false;
  return input.trigger === "interval" ? DIRECTORY_REFRESH_MS : 0;
}

export function surfaceActive(appState: string | null | undefined): boolean {
  return appState !== "background" && appState !== "inactive";
}
