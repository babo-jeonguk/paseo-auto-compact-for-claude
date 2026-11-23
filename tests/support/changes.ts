// A fake calls `changed()` whenever it records something a test may wait for:
// a stored state, a call it received. `until(done)` resolves once `done` holds,
// checked at once and again at every change, so a test waits for the state it
// needs instead of counting event-loop turns. A change that never comes fails
// at the test runner's bound. The condition is read at the change itself, so a
// state that holds only briefly is not missed.
export function changes() {
  const waiting = new Set<{ done: () => boolean; resolve: () => void; reject: (error: unknown) => void }>();
  return {
    changed() {
      for (const waiter of waiting) {
        let done: boolean;
        // A broken condition fails the waiting test, not the fake's caller.
        try { done = waiter.done(); } catch (error) { waiting.delete(waiter); waiter.reject(error); continue; }
        if (done) { waiting.delete(waiter); waiter.resolve(); }
      }
    },
    until(done: () => boolean): Promise<void> {
      return new Promise((resolve, reject) => {
        if (done()) resolve();
        else waiting.add({ done, resolve, reject });
      });
    },
  };
}
