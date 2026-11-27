import { DeadlineExceeded, Stopped, systemTimers, type Timers } from "./deadline";

// The host not answering: a read that timed out, or Paseo's client closing.
// Work that meets it is retried from durable state, so it is a condition.
const hostUnavailable = (error: unknown) => error instanceof DeadlineExceeded ||
  // The Paseo client rejects with a plain Error carrying only this message.
  (error instanceof Error && error.message === "Daemon client closed");

// Every cause of a group, recursively; anything else is its own single cause.
// The one rule for taking a group apart, for the reporter and the worker.
export const causesOf = (error: unknown): unknown[] =>
  error instanceof AggregateError ? error.errors.flatMap(causesOf) : [error];

// How long the host may stay unavailable before it is reported.
export const REPORT_GRACE_MS = 30_000;

// Paseo closes the plugin's API before it calls cleanup, and a daemon that is
// shutting down can stall reads for seconds before that. When such an error
// arrives, nothing yet tells it apart from an outage; cleanup following it
// does. So the host being unavailable is reported only if the plugin is still
// running a grace period later. A defect is reported at once. Each cause of an
// AggregateError is classified on its own, a `Stopped` is the plugin's own stop
// and is never logged, and a report that arrives after dispose is work already
// issued: it goes to teardown, which logs each defect object only once.
export function createReporter(log: (message: string) => void, graceMs = REPORT_GRACE_MS,
  timers: Timers = systemTimers) {
  const waiting = new Set<unknown>();
  // Causes teardown has already logged, so the same failure handed over by
  // several owners at shutdown is not logged twice.
  const logged = new Set<unknown>();
  let disposed = false;
  const defect = (cause: unknown) => !(cause instanceof Stopped) && !hostUnavailable(cause);
  // A failing step of cleanup itself, which can settle after dispose. The host
  // having closed its API then is expected; anything else is a defect.
  const teardown = (error: unknown) => {
    for (const cause of causesOf(error)) {
      if (!defect(cause) || logged.has(cause)) continue;
      logged.add(cause);
      log(String(cause));
    }
  };
  return {
    report(error: unknown) {
      // Work issued before the stop can still fail after it.
      if (disposed) return teardown(error);
      for (const cause of causesOf(error)) {
        if (cause instanceof Stopped) continue;
        if (!hostUnavailable(cause)) { log(String(cause)); continue; }
        const timer = timers.setTimeout(() => { waiting.delete(timer); log(String(cause)); }, graceMs);
        waiting.add(timer);
      }
    },
    teardown,
    dispose() {
      disposed = true;
      for (const timer of waiting) timers.clearTimeout(timer);
      waiting.clear();
    },
  };
}
