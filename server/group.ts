// Work in flight that a caller must later wait for.
export function createGroup(): {
  track<T>(work: Promise<T>): Promise<T>;
  idle(): Promise<void>;
  busy(): boolean;
} {
  let inFlight = 0;
  // Waiters of the current quiet stretch. They resolve the next time the count
  // reaches 0, and the next `idle` after that starts a fresh wait.
  let waiters: Array<() => void> = [];

  return {
    track<T>(work: Promise<T>): Promise<T> {
      inFlight += 1;
      return (async () => {
        try {
          // `await` forwards the work's value or rejection to the caller's
          // promise; the group counts the work and never observes its outcome,
          // so a caller that drops the promise gets the unhandled rejection.
          return await work;
        } finally {
          inFlight -= 1;
          if (inFlight === 0) {
            const resolving = waiters;
            waiters = [];
            for (const resolve of resolving) resolve();
          }
        }
      })();
    },
    idle(): Promise<void> {
      if (inFlight === 0) return Promise.resolve();
      // Work tracked while this waits keeps the count above 0, so the promise
      // resolves only when the group next goes quiet.
      return new Promise<void>(resolve => {
        waiters.push(resolve);
      });
    },
    busy(): boolean {
      return inFlight > 0;
    },
  };
}
