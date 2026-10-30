import type { StoredOperation } from "./model";

export class DeadlineExceeded extends Error {
  constructor() { super("Compaction deadline exceeded"); }
}

// One read of the host, settings, state or observer before anything is sent.
export const INSPECT_TIMEOUT_MS = 5_000;
// From acceptance to the dispatch marker (`sendBy`); an automatic reservation's
// delivery window can shorten it. Faults before the marker are retried until
// then; after it nothing is sent and the request expires.
export const SEND_DEADLINE_MS = 180_000;
// From the dispatch marker: how long matching evidence is awaited before the
// outcome becomes unknown. It never depends on when sending started.
export const OBSERVATION_MS = 180_000;
// Within an observation: the send call, then the live subscription, which a
// gateway call watches itself. Evidence checks continue to OBSERVATION_MS.
export const SEND_TIMEOUT_MS = 30_000;
export const LIVE_OBSERVATION_MS = 120_000;
// Releasing the native request and the subscription after a call.
export const CLEANUP_TIMEOUT_MS = 1_000;

// The deadline that applies to the operation's current phase.
export const deadlineOf = (operation: Pick<StoredOperation, "sendBy" | "evidence">) =>
  operation.evidence?.dispatchStartedAt !== undefined
    ? operation.evidence.dispatchStartedAt + OBSERVATION_MS
    : operation.sendBy ?? 0;
// No observation of work that must start sending by `sendBy` ends later than
// this, so Claude may admit its compaction until then.
export const observationEndBy = (sendBy: number) => sendBy + OBSERVATION_MS;

// Attaching both handlers also consumes late rejections after the timer wins.
// A timeout bounds waiting; it does not cancel a remote side effect.
export function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceeded()), Math.max(0, milliseconds));
    work.then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

// A pre-send read: at most INSPECT_TIMEOUT_MS, and never past `deadline`.
export const readWithin = <T>(work: Promise<T>, deadline: number, now: number) =>
  bounded(work, Math.min(INSPECT_TIMEOUT_MS, deadline - now));
