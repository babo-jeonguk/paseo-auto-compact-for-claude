import type { StoredOperation } from "./model";

export class DeadlineExceeded extends Error {
  constructor() { super("Compaction deadline exceeded"); }
}
// A wait its caller ended by stopping before the wait finished.
export class Stopped extends Error {
  constructor() { super("Compaction attempt stopped"); }
}

// A VM host may step the shared wall clock back to correct drift (WSL2:
// observed -1.8 s every few minutes). A step up to this size is not a rollback.
// Keep equal to the constant in observer-source.mjs and below the 30 s margin
// before a cache deadline, which absorbs the error such a step leaves behind.
export const CLOCK_STEP_TOLERANCE_MS = 10_000;
// One read of the host, settings, state or observer before anything is sent.
export const INSPECT_TIMEOUT_MS = 5_000;
// From acceptance to the dispatch marker (`sendBy`). Faults before the marker
// are retried until then; after it nothing is sent and the request expires.
// Someone is waiting on Compact now, so it allows a few quick retries of a
// passing fault and no more. An automatic reservation has time to wait out a
// longer one; its delivery window can shorten that.
export const SEND_DEADLINE_MS = { manual: 10_000, automatic: 180_000 } as const;
// From the dispatch marker: how long matching evidence is awaited before the
// outcome becomes unknown. It never depends on when sending started.
export const OBSERVATION_MS = 180_000;
// Within an observation: the send call, then the live subscription, which a
// gateway call watches itself. Evidence checks continue to OBSERVATION_MS.
export const SEND_TIMEOUT_MS = 30_000;
export const LIVE_OBSERVATION_MS = 120_000;
// Releasing the native request and the subscription after a call.
export const CLEANUP_TIMEOUT_MS = 1_000;

// Timers the scheduler, the operation worker and the gateway schedule through,
// and every bounded wait runs on. Handles stay opaque so a caller can supply a
// fake implementation.
export type Timers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

// The system default unrefs its timers so a pending wake-up never keeps the process alive.
export const systemTimers: Timers = {
  setTimeout(callback, milliseconds) {
    // eslint-disable-next-line no-restricted-syntax -- the one real implementation of Timers
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return timer;
  },
  clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

// The deadline that applies to the operation's current phase.
export const deadlineOf = (operation: Pick<StoredOperation, "sendBy" | "evidence">) =>
  operation.evidence?.dispatchStartedAt !== undefined
    ? operation.evidence.dispatchStartedAt + OBSERVATION_MS
    : operation.sendBy ?? 0;
// No observation of work that must start sending by `sendBy` ends later than
// this, so Claude may admit its compaction until then.
export const observationEndBy = (sendBy: number) => sendBy + OBSERVATION_MS;

// Attaching both handlers also consumes late rejections after the timer wins.
// A timeout bounds waiting; it does not cancel a remote side effect. The wait
// runs on the caller's timers, and `stop`, when given, ends it early when the
// caller stops, rejecting at once without arming a timer if it has already
// stopped. `Infinity` means no deadline of its own: no timer is armed, and the
// wait ends only when the work settles or `stop` aborts. It settles once: a
// late settle, abort or deadline after it ended does nothing. However it ends,
// a timer it armed is cleared; a wait that armed none clears none.
export function bounded<T>(work: Promise<T>, milliseconds: number, timers: Timers, stop?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let ended = false;
    let armed = false;
    let timer: unknown;
    const end = (settle: () => void) => {
      if (ended) return;
      ended = true;
      if (armed) timers.clearTimeout(timer);
      stop?.removeEventListener("abort", stopped);
      settle();
    };
    const stopped = () => end(() => reject(new Stopped()));
    // Never hand Infinity to setTimeout: Node turns it into 1 ms. A wait after
    // stop arms nothing, since it ends at once.
    if (milliseconds !== Infinity && !stop?.aborted) {
      timer = timers.setTimeout(() => end(() => reject(new DeadlineExceeded())), Math.max(0, milliseconds));
      armed = true;
    }
    work.then(value => end(() => resolve(value)), error => end(() => reject(error)));
    if (stop?.aborted) stopped();
    else stop?.addEventListener("abort", stopped, { once: true });
  });
}
// A component's one lifetime, which `end()` ends. Every await of the
// component goes through `wait`: bounded by its own deadline where it has one
// and by the lifetime where it has none, so ending the lifetime ends them all
// at once and clears their timers. `begin` starts I/O only while the lifetime
// lasts and returns it as it is, for the caller to wait on. Each side effect goes
// through an owner that does nothing once `live()` is false, so no step of the
// component checks for itself.
export function createLifetime(timers: Timers) {
  const controller = new AbortController();
  const live = () => !controller.signal.aborted;
  const wait = <T>(work: Promise<T>, milliseconds = Infinity) =>
    bounded(work, milliseconds, timers, controller.signal);
  return {
    signal: controller.signal,
    live,
    wait,
    begin: <T>(work: () => Promise<T>): Promise<T> => live() ? work() : Promise.reject(new Stopped()),
    end: () => controller.abort(),
  };
}

// A pause of `milliseconds`, which `stop` ends early.
export const pause = (milliseconds: number, timers: Timers, stop?: AbortSignal) =>
  bounded(new Promise<never>(() => {}), milliseconds, timers, stop).catch((error: unknown) => {
    if (!(error instanceof DeadlineExceeded)) throw error;
  });

// A pre-send read: at most INSPECT_TIMEOUT_MS, and never past `deadline`.
export const readWithin = <T>(work: Promise<T>, deadline: number, now: number, timers: Timers, stop?: AbortSignal) =>
  bounded(work, Math.min(INSPECT_TIMEOUT_MS, deadline - now), timers, stop);
