// Unit tests drive time through an injected clock or mock.timers and wait on
// observable state. A test still needs to fail, not hang, when the state it
// waits for never comes; this module owns the one real timer that allows.
// Lint permits a delayed real timer in unit tests only here.

// Only a test that is already failing waits this long: every passing wait is
// in-memory work or a local process step, far shorter even on a slow runner.
export const FAILURE_BOUND_MS = 5_000;

// The work's value, or null if it is still pending at the bound. Attaching both
// handlers also consumes a rejection that arrives after the bound.
export function settledWithin<T>(work: Promise<T>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), FAILURE_BOUND_MS);
    work.then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}
