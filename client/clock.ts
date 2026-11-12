// One timer for every mounted control, set for the next visible change instead of ticking every second.
export interface ClockTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SharedClock {
  /** `nextAt(now)` returns the absolute time this subscriber next needs a render, or null for none. */
  subscribe(listener: (now: number) => void, nextAt: (now: number) => number | null): () => void;
  /** Recompute the earliest boundary after a subscriber's inputs changed (call after each render). */
  reschedule(): void;
  /** Notify every subscriber now (e.g. the app returned to the foreground), then reschedule. */
  notify(): void;
  now(): number;
}

type Subscriber = { listener: (now: number) => void; nextAt: (now: number) => number | null };

export function createSharedClock(timers: Partial<ClockTimers> = {}): SharedClock {
  const clock: ClockTimers = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...timers,
  };
  const subscribers = new Set<Subscriber>();
  let handle: unknown = null;
  let scheduledAt: number | null = null;

  const reschedule = () => {
    const now = clock.now();
    let at: number | null = null;
    for (const subscriber of subscribers) {
      const next = subscriber.nextAt(now);
      if (next !== null && (at === null || next < at)) at = next;
    }
    if (at === scheduledAt) return;
    if (handle !== null) clock.clearTimeout(handle);
    handle = null;
    scheduledAt = at;
    if (at !== null) handle = clock.setTimeout(fire, Math.max(0, at - now));
  };

  const notify = () => {
    const now = clock.now();
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.listener(now);
      } catch {
        // Listeners only trigger rendering; one failed render must not stop the clock.
      }
    }
    reschedule();
  };
  const fire = () => {
    handle = null;
    scheduledAt = null;
    notify();
  };

  const subscribe = (listener: (now: number) => void, nextAt: (now: number) => number | null) => {
    const subscriber = { listener, nextAt };
    subscribers.add(subscriber);
    reschedule();
    return () => {
      if (subscribers.delete(subscriber)) reschedule();
    };
  };

  return { subscribe, reschedule, notify, now: () => clock.now() };
}

export const sharedClock: SharedClock = createSharedClock();
