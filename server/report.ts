import { DeadlineExceeded } from "./deadline";

// The host not answering: a read that timed out, or Paseo's client closing.
// Work that meets it is retried from durable state, so it is a condition.
const hostUnavailable = (error: unknown) => error instanceof DeadlineExceeded ||
  // The Paseo client rejects with a plain Error carrying only this message.
  (error instanceof Error && error.message === "Daemon client closed");

// How long the host may stay unavailable before it is reported.
export const REPORT_GRACE_MS = 30_000;

// Paseo closes the plugin's API before it calls cleanup, and a daemon that is
// shutting down can stall reads for seconds before that. When such an error
// arrives, nothing yet tells it apart from an outage; cleanup following it
// does. So the host being unavailable is reported only if the plugin is still
// running a grace period later. Any other error is reported at once.
export function createReporter(log: (message: string) => void, graceMs = REPORT_GRACE_MS) {
  const waiting = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  return {
    report(error: unknown) {
      if (disposed) return;
      if (!hostUnavailable(error)) return log(String(error));
      const timer = setTimeout(() => { waiting.delete(timer); log(String(error)); }, graceMs);
      timer.unref?.();
      waiting.add(timer);
    },
    dispose() {
      disposed = true;
      for (const timer of waiting) clearTimeout(timer);
      waiting.clear();
    },
  };
}
