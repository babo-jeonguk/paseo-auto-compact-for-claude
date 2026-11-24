// Timers the code under test schedules through its injected `timers`. Nothing
// runs until the test moves them on with `tick`, and arming one calls
// `onArm`, so a test can wait for a timer to be set (with `changes()`) instead
// of guessing when the code reached it.
export function fakeTimers(onArm: () => void = () => {}) {
  const pending = new Map<object, { left: number; callback: () => void }>();
  return {
    setTimeout(callback: () => void, ms: number): unknown {
      const handle = {};
      pending.set(handle, { left: Math.max(0, ms), callback });
      onArm();
      return handle;
    },
    clearTimeout(handle: unknown) {
      if (typeof handle === "object" && handle) pending.delete(handle);
    },
    get pending() { return pending.size; },
    // How many pending timers `tick(ms)` would run.
    pendingWithin(ms: number) { return [...pending.values()].filter(timer => timer.left <= ms).length; },
    // Moves every timer pending now on by `ms` and runs those that come due,
    // earliest first. Like a real timer, a callback runs on a later turn than
    // the code that armed it, so that code finishes first, and a timer stays
    // pending until it runs, so clearing it before then cancels it. Node runs
    // the microtasks a callback queued before the next one, so a promise
    // chain one callback started can still clear a later one; an immediate
    // between callbacks lets that chain finish. A timer armed by one of them
    // waits for the next tick.
    async tick(ms: number) {
      const due: [object, { left: number; callback: () => void }][] = [];
      for (const entry of pending) {
        entry[1].left -= ms;
        if (entry[1].left <= 0) due.push(entry);
      }
      for (const [handle, timer] of due.sort((a, b) => a[1].left - b[1].left)) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (!pending.delete(handle)) continue;
        timer.callback();
      }
      // Without a due timer the tick still ends on a later turn, so a caller
      // never sees it finish within its own turn.
      if (!due.length) await new Promise<void>(resolve => setImmediate(resolve));
    },
  };
}
