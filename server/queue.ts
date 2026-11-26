// One serial queue: each entry starts once the previous one has ended,
// whatever its outcome, and its caller gets its own work's outcome.
export function createKeyedQueue<K>(): {
  run<T>(key: K, work: () => Promise<T>): Promise<T>;
  hold(key: K): { ready: Promise<void>; release(after?: Promise<void>): void };
  idle(key: K): Promise<void>;
} {
  throw new Error("not implemented");
}

export function createQueue(): { run<T>(work: () => Promise<T>): Promise<T> } {
  throw new Error("not implemented");
}
