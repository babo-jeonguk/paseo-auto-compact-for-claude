// Timers the code under test schedules through its injected `timers`, and the
// time it reads from them (`now()`, for code such as the client clock that
// takes both together). Nothing runs until the test moves them on with `tick`
// or `jump`, and arming one calls `onArm`, so a test can wait for a timer to be
// set (with `changes()`) instead of guessing when the code reached it.
export function fakeTimers(onArm: () => void = () => {}, start = 0) {
  type Timer = { at: number; callback: () => void };
  const pending = new Map<object, Timer>();
  let time = start;
  // A callback runs on a later turn than the code that armed it or ran before
  // it, as with real timers: that code finishes first, and the microtasks one
  // callback queued run before the next, so a promise chain it started can
  // still clear a later timer.
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  // The pending timer due first by `until`; ties run in the order they were armed.
  const earliest = (until: number) => {
    let first: [object, Timer] | undefined;
    for (const entry of pending) if (entry[1].at <= until && (!first || entry[1].at < first[1].at)) first = entry;
    return first;
  };
  return {
    now: () => time,
    setTimeout(callback: () => void, ms: number): unknown {
      const handle = {};
      pending.set(handle, { at: time + Math.max(0, ms), callback });
      onArm();
      return handle;
    },
    clearTimeout(handle: unknown) {
      if (typeof handle === "object" && handle) pending.delete(handle);
    },
    get pending() { return pending.size; },
    // When each pending timer comes due, earliest first.
    get dueTimes() { return [...pending.values()].map(timer => timer.at).sort((a, b) => a - b); },
    // How many pending timers `tick(ms)` would run.
    pendingWithin(ms: number) { return [...pending.values()].filter(timer => timer.at <= time + ms).length; },
    // Moves the time on by `ms` at once, as a busy event loop finds it when it
    // gets to its timers, and runs the timers pending now that came due,
    // earliest first, each on a later turn and each seeing the new time. A
    // timer stays pending until it runs, so clearing it before then cancels
    // it. A timer armed by one of them waits for the next tick.
    async tick(ms: number) {
      time += ms;
      const due = [...pending].filter(([, timer]) => timer.at <= time).sort((a, b) => a[1].at - b[1].at);
      for (const [handle, timer] of due) {
        await turn();
        if (!pending.delete(handle)) continue;
        timer.callback();
      }
      // Without a due timer the tick still ends on a later turn, so a caller
      // never sees it finish within its own turn.
      if (!due.length) await turn();
    },
    // Moves the time on by `ms` as an idle event loop would: to each timer's
    // due time in turn, running it there on a later turn, including timers
    // the callbacks arm that come due before the jump ends.
    async jump(ms: number) {
      const until = time + ms;
      while (true) {
        await turn();
        const next = earliest(until);
        if (!next) break;
        pending.delete(next[0]);
        time = Math.max(time, next[1].at);
        next[1].callback();
      }
      time = until;
    },
  };
}

// Timers whose handles take the forms `bounded()` must still clear by: an
// opaque `Timers` may return no handle at all, or reuse a retired one. The
// handles `fakeTimers()` returns are distinct objects, so it cannot show
// either. Neither moves time; a test fires a numbered timer itself.
export function undefinedHandleTimers() {
  const cleared: unknown[] = [];
  return {
    cleared,
    setTimeout(_callback: () => void, _ms: number): unknown { return undefined; },
    clearTimeout(handle: unknown) { cleared.push(handle); },
  };
}

// Numbered handles, the lowest free one reused, as some timer implementations do.
export function reusedHandleTimers() {
  const due = new Map<number, () => void>();
  return {
    setTimeout(callback: () => void, _ms: number): unknown {
      let id = 1;
      while (due.has(id)) id++;
      due.set(id, callback);
      return id;
    },
    clearTimeout(handle: unknown) { due.delete(handle as number); },
    get pending() { return due.size; },
    fire(id: number) {
      const callback = due.get(id);
      if (!callback) throw new Error(`No timer ${id} is pending`);
      due.delete(id);
      callback();
    },
  };
}
