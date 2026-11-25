export const SESSION_POLL_MS = 10_000; // safety poll while the surface is active
export const SESSION_BACKOFF_MS = 30_000; // after SESSION_BACKOFF_FAILURES consecutive failures
export const SESSION_BACKOFF_FAILURES = 3;
// Bound for an operation that is never found. Changes arrive through the
// subscription; a surface without one reads at the status safety cadence.
export const OPERATION_LOOKUP_MS = 30_000;
export const DIRECTORY_REFRESH_MS = 5 * 60_000; // directory safety refresh
export const POLL_JITTER_MS = 5_000;
// Status tolerates one missed poll plus network jitter: a read stays fresh this long,
// and a refresh still pending this long is reported as not refreshed.
export const STATUS_FRESH_MS = 2 * SESSION_POLL_MS + POLL_JITTER_MS;

export type PollEvent = "success" | "failure" | "focus" | "reconnect";

export function pollFailures(previous: number, event: PollEvent): number {
  return event === "failure" ? previous + 1 : 0;
}

const failuresBySession = new Map<string, number>();
const recoveryListeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();

// A status poll that recovers after failures is a reconnect signal for discovery.
export function onSessionRecovered(listener: () => void): () => void {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}

// A detected reconnect refreshes every mounted status control.
export function onHostReconnected(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => { reconnectListeners.delete(listener); };
}

// Every conversation starts over from the ten-second poll after a reconnect.
export function hostReconnected(): void {
  failuresBySession.clear();
  for (const listener of reconnectListeners) {
    try { listener(); } catch { /* one broken listener must not stop the rest */ }
  }
}

// Every control of one conversation shares its backoff, however many are mounted.
export function sessionFailures(key: string): { count(): number; record(event: PollEvent): void } {
  return {
    count: () => failuresBySession.get(key) ?? 0,
    record(event) {
      const previous = failuresBySession.get(key) ?? 0;
      const next = pollFailures(previous, event);
      if (next === 0) failuresBySession.delete(key);
      else failuresBySession.set(key, next);
      if (event === "success" && previous > 0)
        for (const listener of recoveryListeners) {
          try { listener(); } catch { /* one broken listener must not stop the rest */ }
        }
    },
  };
}

export function sessionPollDelay(input: { active: boolean; failures: number }): number | false {
  if (!input.active) return false;
  return input.failures >= SESSION_BACKOFF_FAILURES ? SESSION_BACKOFF_MS : SESSION_POLL_MS;
}

// A failed read would otherwise stay failed until the next change; a live
// subscription refreshes the list on every change, and without one the list has
// nothing else.
export function listPollDelay(input: { live: boolean; active: boolean; failed: boolean }): number | false {
  if (!input.active) return false;
  return !input.live || input.failed ? SESSION_POLL_MS : false;
}

// Changes arrive through the subscription; this lookup only covers a surface
// without one, at the status safety cadence, until a missing record is given up.
export function operationPollDelay(input: {
  active: boolean; failures: number; found: boolean; pending: boolean; elapsed: number;
}): number | false {
  if (!input.active) return false;
  if (input.found && !input.pending) return false;
  if (!input.found && input.elapsed >= OPERATION_LOOKUP_MS) return false;
  return sessionPollDelay({ active: input.active, failures: input.failures });
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
