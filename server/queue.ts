// One serial queue: each entry starts once the previous one has ended,
// whatever its outcome, and its caller gets its own work's outcome.
export function createKeyedQueue<K>(): {
  run<T>(key: K, work: () => Promise<T>): Promise<T>;
  hold(key: K): { ready: Promise<void>; release(after?: Promise<void>): void };
  idle(key: K): Promise<void>;
} {
  // The last entry's tail per key. A tail only ever resolves, so a chain never
  // depends on an entry's outcome and `idle` can wait on it without handling a
  // rejection.
  const tails = new Map<K, Promise<void>>();
  // A key with no entry is idle at once, so an unused key costs no promise.
  const settled: Promise<void> = Promise.resolve();

  function hold(key: K): { ready: Promise<void>; release(after?: Promise<void>): void } {
    const earlier = tails.get(key) ?? settled;
    let releaseOwn!: (after: Promise<void> | undefined) => void;
    // `own` is what this entry's release resolves, apart from the tail so a
    // release before the entry reaches the front still frees the slot only
    // after the entries before it have ended.
    const own = new Promise<void>(resolve => {
      releaseOwn = after => resolve(after);
    });
    let released = false;
    // Resolving `own` with `after` makes the tail wait for that work too: the
    // slot is handed on only once the earlier entries and it have both ended.
    const settle = async () => {
      await earlier;
      await own;
      // Only the last entry of its chain clears the key: a newer entry has
      // already stored its own tail, which later entries must keep waiting on.
      if (tails.get(key) === tail) tails.delete(key);
    };
    const tail = settle();
    tails.set(key, tail);
    return {
      ready: earlier,
      release(after?: Promise<void>): void {
        // A second release is a no-op: this entry has already handed its slot
        // on, and releasing again could free a later entry early.
        if (released) return;
        released = true;
        releaseOwn(after);
      },
    };
  }

  return {
    run<T>(key: K, work: () => Promise<T>): Promise<T> {
      const entry = hold(key);
      return (async () => {
        await entry.ready;
        try {
          // The `await` keeps a synchronous throw inside the try, so the slot
          // is released on either outcome, and the caller still gets the work's
          // own value or rejection.
          return await work();
        } finally {
          entry.release();
        }
      })();
    },
    idle(key: K): Promise<void> {
      return tails.get(key) ?? settled;
    },
    hold,
  };
}

export function createQueue(): { run<T>(work: () => Promise<T>): Promise<T> } {
  // One keyed queue behind a single fixed key keeps the serialization rule in
  // one place.
  const queue = createKeyedQueue<undefined>();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      return queue.run(undefined, work);
    },
  };
}
