import { createHash, randomUUID } from "node:crypto";
import { finishedState, operationRowStatus, operationPending, type CompactOperation, type CompactTarget,
  type ResultCode } from "../shared/rpc";
import { Refusal, readable, samePreparation, unchanged, type CompactOutcome, type Gateway, type LeftoverRequest,
  type State, type StateStore, type StoredOperation } from "./model";
import type { Settings } from "../shared/settings";
import { createLifetime, DeadlineExceeded, deadlineOf, INSPECT_TIMEOUT_MS, OBSERVATION_MS, readWithin, Stopped, systemTimers,
  type Timers } from "./deadline";
import { automaticBlock } from "./policy";
import { causesOf } from "./report";

export function inputFingerprint(agentId: string, revision: string, target?: CompactTarget) {
  // Preserve omitted legacy target as part of caller intent. Never re-fingerprint
  // using a refreshed session when the caller retries a lost acknowledgement.
  return createHash("sha256").update(JSON.stringify([
    "manual", agentId, revision, target ? [target.sessionId, target.activityKey] : null,
  ])).digest("hex");
}

export function publicOperation(operation: StoredOperation): CompactOperation {
  const { id, agentId, revision, target, kind, state, createdAt, updatedAt, result } = operation;
  return { id, agentId, revision, target, kind, state, createdAt, updatedAt, result };
}

export function sameActivity(operation: Pick<CompactOperation, "agentId" | "revision" | "target">, agent: {
  agentId: string; revision: string | null; sessionId: string | null; activityKey?: string | null;
}) {
  if (operation.agentId !== agent.agentId) return false;
  // Missing legacy identities are conservative: retain the old revision guard.
  if (operation.target.sessionId && operation.target.sessionId !== agent.sessionId) return false;
  return operation.target.activityKey && agent.activityKey
    ? operation.target.activityKey === agent.activityKey
    : operation.revision === agent.revision;
}

// Only an expired request, or a failure without the persisted dispatch marker,
// proves that nothing was sent. Legacy history never recorded the marker.
export const mayHaveSent = (operation: StoredOperation) => operation.kind === "legacy" ||
  !(operation.state === "expired" || (operation.state === "failed" && operation.evidence?.dispatchStartedAt === undefined));

export function leftoverRetirement(request: LeftoverRequest, operation: StoredOperation | undefined): { sent: boolean } | null {
  // An operation no longer retained ended at least the retention period ago.
  if (!operation) return { sent: false };
  if (operationPending(operation)) {
    // Pending without the dispatch marker: the earlier instance never sent it,
    // and a retry prepares a fresh request.
    if (operation.evidence?.dispatchStartedAt === undefined) return { sent: false };
    // Possibly sent and still observed with the same preparation: the observer
    // needs the request to attribute its outcome. A side naming no preparation,
    // from an earlier release, is matched by the operation.
    const native = operation.evidence.native?.preparation;
    return samePreparation(request.preparation, native) ? null : { sent: true };
  }
  // Finished: retired as the worker's release would, sent once the marker exists.
  return { sent: operation.evidence?.dispatchStartedAt !== undefined };
}

// Jobs keep the fields v1.0.2 reads, so a rollback neither replays an attempted
// reservation nor blocks a retry of one that sent nothing. The scheduler applies
// this to every state it writes; nothing else writes these job fields.
export function syncJobs(state: State) {
  for (const job of state.jobs) {
    const operation = job.operationId ? state.operations.find(entry => entry.id === job.operationId) : undefined;
    if (!operation) continue;
    job.status = operationRowStatus(operation);
    job.detail = operation.result?.message ?? "Compaction requested; waiting for completed compaction boundary";
    if (mayHaveSent(operation)) job.attemptedAt ??= operation.createdAt;
    else delete job.attemptedAt;
  }
  return state;
}

// Retries of a fault before the marker; the send deadline bounds how many.
const MAX_RETRY_DELAY_MS = 30_000;

type Ending = CompactOutcome | "expired";
function resultOf(ending: Ending, dispatched: boolean): { code: ResultCode; message: string } {
  if (ending === "expired") return { code: "expired_before_dispatch", message: "Compaction request expired before dispatch" };
  const code = ending.status === "completed" ? "completed" : ending.status === "unknown" ? "unknown"
    : dispatched ? "failed_after_dispatch" : "failed_before_dispatch";
  return { code, message: ending.detail };
}
const stateOf = (ending: Ending): StoredOperation["state"] =>
  finishedState(ending === "expired" ? "expired" : ending.status);

export function recoverOperations(state: State, now: number) {
  for (const operation of state.operations) {
    if (!operationPending(operation)) continue;
    operation.state = operation.evidence?.dispatchStartedAt !== undefined ? "observing" : "requested";
    delete operation.owner;
    operation.updatedAt = now;
  }
}

// This module owns execution/recovery; the scheduler supplies its one state
// transaction queue, so claims, checkpoints and completions of concurrent
// conversations cannot race.
export function createOperationWorker(options: {
  store: StateStore;
  update<T>(change: (state: State) => T): Promise<T>;
  gateway: Gateway;
  settings(): Promise<Settings | null>;
  now(): number;
  timers?: Timers;
  onError(error: unknown): void;
}) {
  const { store, gateway, settings, now } = options;
  const timers = options.timers ?? systemTimers;
  const owner = randomUUID();
  // Reports: a stopped worker's run can still meet a fault of work it already
  // issued; the reporter keeps the stop itself quiet.
  const onError = (error: unknown) => options.onError(error);
  // The worker's one lifetime, which stop() ends. Every await of a run waits on
  // it — reads, state transactions, the dispatch call — as the gateway's waits
  // take the gateway's signal, and a read starts only while it lasts. Every
  // side effect (a state write, a native request's release, a retry's wake-up,
  // and a send, which the gateway asks `current()` about) is fenced while it
  // lasts; a report is not, since a fault of work already issued still matters.
  const lifetime = createLifetime(timers, error => onError(error));
  const { live, wait, begin } = lifetime;
  // State writes: a stopped worker's transaction changes nothing and fails,
  // checked when it runs, since the queue can hold it past stop(); the caller's
  // wait on it also ends at once. A run passes its own owner for a rejection
  // that arrives after that wait ended.
  const update = <T>(change: (state: State) => T, owner: (error: unknown) => void = onError) =>
    wait(options.update(state => { if (!live()) throw new Stopped(); return change(state); }), Infinity, owner);
  // Retiring a finished operation's native request. A stopped worker starts no
  // retirement, because its durable writes have closed (the plugin's stop closes
  // them first); a request left prepared is retired by the next instance's
  // startup recovery, and until then the observer checks at most one /compact
  // against it. A release that fails while it is waited on is not reported,
  // since the operation has already ended; one that fails after its wait ended
  // goes to the error owner, as every late failure does.
  const release = async (operation: StoredOperation) => {
    if (live() && operation.evidence?.native && gateway.release)
      await wait(gateway.release(operation), INSPECT_TIMEOUT_MS).catch(() => {});
  };
  // Outcomes whose terminal write failed; they are written again, never re-earned.
  const outcomes = new Map<string, Ending>();
  // A deadline or stop that ended a wait, as opposed to a failure the work met.
  const bound = (fault: unknown) => fault instanceof DeadlineExceeded || fault instanceof Stopped;
  // The cause each request carries toward its expiry: the fault its last run
  // ended with. The next run's cause replaces it, unless that is only a
  // deadline or stop and the carried one is a failure the work met, which then
  // explains the request better. It is reported once, when the request expires
  // or when this worker stops first and leaves the request to the next
  // instance. Kept across a failed save.
  const causes = new Map<string, unknown>();
  // From its classification on, a run's cause is its request's. A stopped
  // worker carries nothing to a later expiry, so it reports it at once.
  const handOver = (id: string, cause: unknown) => {
    if (!live()) onError(cause);
    else if (!bound(cause) || !causes.has(id) || bound(causes.get(id))) causes.set(id, cause);
  };
  // A failure the work met takes the place of a carried deadline or stop; any
  // other fault can no longer become the cause, and is reported at once.
  const carry = (id: string, error: unknown) => {
    if (causes.has(id) && bound(causes.get(id)) && !bound(error)) causes.set(id, error);
    else onError(error);
  };
  let lastConnected = true;
  // Runs this worker has in flight, keyed by operation, so a second reconcile
  // never starts the same operation twice.
  const active = new Map<string, Promise<void>>();
  // One retry wake-up per operation: another conversation's fault cannot cancel
  // or delay this operation's retry.
  const retries = new Map<string, unknown>();
  // Pending work this worker claimed and still holds.
  const held = (operation: StoredOperation | undefined): operation is StoredOperation =>
    !!operation && operationPending(operation) && operation.owner === owner;
  function settle(operation: StoredOperation, ending: Ending) {
    operation.state = stateOf(ending);
    operation.result = resultOf(ending, operation.evidence?.dispatchStartedAt !== undefined);
    operation.updatedAt = now();
    delete operation.owner;
  }
  // Sending must start by sendBy, and automatic work within its delivery window.
  const expiredUnsent = (operation: StoredOperation) =>
    now() >= operation.sendBy! || now() > (operation.deliveryExpiresAt ?? Infinity);
  async function finish(id: string, ending: Ending, owner: (error: unknown) => void = onError) {
    outcomes.set(id, ending);
    const finished = await update(state => {
      const operation = state.operations.find(entry => entry.id === id);
      if (!held(operation)) return null;
      settle(operation, ending);
      return structuredClone(operation);
    }, owner);
    outcomes.delete(id);
    // Read once the terminal write has landed, so a fault met during it counts.
    const carried = causes.has(id), cause = causes.get(id);
    causes.delete(id);
    if (finished && ending === "expired" && carried) onError(cause);
    if (finished) await release(finished);
  }
  // One owner of this worker's retry wake-ups. A retry saved by a worker that
  // has stopped since schedules nothing, and a newer wake-up replaces the old
  // one so a conversation's retry is neither doubled nor delayed by another.
  function armRetry(id: string, delay: number) {
    if (!live()) return;
    const previous = retries.get(id);
    if (previous !== undefined) timers.clearTimeout(previous);
    const timer = timers.setTimeout(() => {
      retries.delete(id);
      void reconcile(lastConnected).catch(onError);
    }, delay);
    retries.set(id, timer);
  }
  // Every reconcile scans all pending work: conversations run independently and
  // a second call must not start an operation already running. Callers wait only
  // for runs they started; a request saved during a run is picked up by the next
  // reconcile the scheduler makes after saving it.
  async function reconcile(connected = true) {
    lastConnected = connected;
    let state: State;
    try { state = await wait(begin(() => store.read())); }
    catch (error) { return onError(error); }
    const started: Promise<void>[] = [];
    for (const candidate of state.operations.filter(operationPending)) {
      if (active.has(candidate.id)) continue;
      const task = run(candidate, connected).catch(onError).finally(() => active.delete(candidate.id));
      active.set(candidate.id, task);
      started.push(task);
    }
    await Promise.all(started);
  }
  async function run(candidate: StoredOperation, connected: boolean) {
    let claimed: StoredOperation | undefined;
    // A fault this attempt's work meets after a wait on it ended joins the run
    // while it is going, and its request once the run handed its cause over;
    // after the run ended, it is reported at once. A refusal is a condition the
    // run classifies itself; the reporter keeps the plugin's own stop quiet. A
    // failure of the attempt's cleanup never explains its outcome, so it is
    // reported when it happens.
    let ended = false;
    let handed: string | null = null;
    const joined: unknown[] = [];
    // A group of failures counts as its separate failures.
    const late = (error: unknown) => {
      for (const failure of causesOf(error)) {
        if (failure instanceof Refusal) continue;
        if (ended) onError(failure);
        else if (handed !== null) carry(handed, failure);
        else joined.push(failure);
      }
    };
    try {
      if (!outcomes.has(candidate.id) && now() < (candidate.nextAttemptAt ?? 0) && now() < deadlineOf(candidate)) return;
      // Expiry and retained local outcomes can progress even before host attach.
      if (!connected && !outcomes.has(candidate.id) && !candidate.evidence?.boundary && now() < deadlineOf(candidate)) return;
      // Startup recovery clears owners, so a claim only ever replaces an earlier
      // worker of this process; that worker's later checkpoints then fail.
      const operation = await update(state => {
        const current = state.operations.find(entry => entry.id === candidate.id);
        if (!current || !operationPending(current)) return null;
        // A snapshot read before a fault must not skip the wait that fault wrote.
        if (!outcomes.has(current.id) && now() < (current.nextAttemptAt ?? 0) &&
            now() < deadlineOf(current)) return null;
        current.owner = owner;
        current.updatedAt = now();
        if (current.evidence?.dispatchStartedAt === undefined && !outcomes.has(current.id)) {
          current.state = "dispatching";
          current.attempt = (current.attempt ?? 0) + 1;
        }
        return structuredClone(current);
      }, late);
      if (!operation) return;
      claimed = operation;
      const remembered = outcomes.get(operation.id);
      if (remembered) return await finish(operation.id, remembered, late);
      if (operation.evidence?.dispatchStartedAt !== undefined) {
        let result: CompactOutcome | null = null;
        if (gateway.inspect && (connected || operation.evidence?.boundary)) {
          try { result = await wait(begin(() => gateway.inspect!(operation)), INSPECT_TIMEOUT_MS, late); }
          catch (error) { onError(error); }
        }
        if (result) return await finish(operation.id, result, late);
        if (now() >= deadlineOf(operation)) return await finish(operation.id,
          { status: "unknown", detail: "Compaction deadline passed without matching completion evidence; no automatic retry" }, late);
        return;
      }
      // Sending must start by this time; observation then has its own deadline.
      const sendBy = operation.sendBy!;
      if (expiredUnsent(operation)) return await finish(operation.id, "expired", late);
      const read = <T>(work: () => Promise<T>) => readWithin(begin(work), sendBy, now(), timers, late, lifetime.signal);
      // Reading nothing is not evidence of change: an unreadable host, observer
      // or setting is thrown as a fault and retried; only a reading that shows a
      // change ends the attempt.
      const [agent, config] = await Promise.all([read(() => gateway.refresh(operation.agentId)).then(readable), read(() => settings())]);
      if (!config) throw new Error("Compact settings could not be read");
      const allowed = async () => {
        const [latest, state] = await Promise.all([read(() => settings()), read(() => store.read())]);
        if (!latest) throw new Error("Compact settings could not be read");
        return !!agent && operation.reservationEndedAt !== undefined &&
          now() <= (operation.deliveryExpiresAt ?? Infinity) &&
          automaticBlock({ agentId: operation.agentId, endedAt: operation.reservationEndedAt,
            settings: latest, disabled: state.disabled, now: now(), agent }) === null;
      };
      if (!agent?.eligible || !agent.idle || !unchanged(operation, agent) ||
          (operation.kind === "automatic" && (!gateway.automatic || !await allowed())))
        return await finish(operation.id,
          { status: "failed", detail: "Session, activity or policy changed before dispatch" }, late);
      let observeUntil: number | null = null;
      const execution = {
        id: operation.id, sendBy: sendBy,
        // The gateway asks this right before sending and again at the dispatch
        // marker, so a stopped worker sends nothing.
        current: () => live() && now() < (observeUntil ?? sendBy),
        fault: late,
        cleanupFault: (error: unknown) => onError(error),
        checkpoint: async (evidence: NonNullable<StoredOperation["evidence"]>) => {
          await update(state => {
            const current = state.operations.find(entry => entry.id === operation.id);
            if (!held(current) || now() >= deadlineOf({ ...current, evidence: { ...current.evidence, ...evidence } }))
              throw new Error("Compaction worker ownership expired");
            current.evidence = { ...current.evidence, ...evidence,
              invalidated: !!current.evidence?.invalidated || !!evidence.invalidated };
            if (current.evidence.dispatchStartedAt !== undefined) current.state = "observing";
            current.updatedAt = now();
          }, late);
          if (evidence.dispatchStartedAt !== undefined) observeUntil = evidence.dispatchStartedAt + OBSERVATION_MS;
        },
      };
      // Before the dispatch marker the gateway throws instead; see below.
      const outcome = await wait(operation.kind === "automatic"
        ? gateway.automatic!(agent, { expiresAt: Math.min(operation.deliveryExpiresAt ?? Infinity, sendBy), allowed }, execution)
        : gateway.compact(agent.agentId, agent, execution), Infinity, late);
      if (outcome.status === "unknown") {
        const saved = (await wait(begin(() => store.read()), Infinity, late)).operations.find(entry => entry.id === operation.id);
        if (saved?.evidence?.dispatchStartedAt !== undefined && !saved.evidence.invalidated && now() < deadlineOf(saved))
          return; // Ambiguous delivery continues through evidence reconciliation.
      }
      await finish(operation.id, outcome, late);
    } catch (error) {
      // The one place an error before the dispatch marker is classified. A
      // refusal ends the attempt with nothing sent. A fault keeps the durable
      // record and is retried until the send deadline, then expires unsent;
      // only the fault that ends it is reported. The decision is made on the
      // stored record, never on the copy taken at claim: work whose marker was
      // written during this run is not ours to expire, and is never resent.
      // The run's cause: its own fault, or the first failure its work met in
      // place of a deadline or stop that ended a wait, which then only marks
      // the wait's end. A refusal is a condition, never a cause. Every other
      // failure the run met can no longer become a cause, so it is reported
      // now, as is the cause of a run that does not hand it to its request:
      // dropping either would hide a defect.
      const settle = () => {
        const met = [...causesOf(error).filter(failure => !(failure instanceof Refusal)), ...joined.splice(0)];
        const at = Math.max(0, met.findIndex(fault => !bound(fault)));
        met.forEach((fault, index) => { if (index !== at && !bound(fault)) onError(fault); });
        return met.length ? { cause: met[at] } : null;
      };
      const report = () => {
        const settled = settle();
        if (settled) onError(settled.cause);
      };
      if (!claimed || outcomes.has(claimed.id)) return report();
      const id = claimed.id;
      let next: "not-classified" | "refused" | "expired" | number;
      try {
        next = await update(state => {
          const current = state.operations.find(entry => entry.id === id);
          if (!held(current) || current.evidence?.dispatchStartedAt !== undefined) return "not-classified" as const;
          if (error instanceof Refusal) return "refused" as const;
          if (expiredUnsent(current)) return "expired" as const;
          // Never wait past the send deadline: the expiry is reported on time.
          const delay = Math.min(1_000 * 2 ** Math.max(0, (current.attempt ?? 1) - 1) + Math.floor(Math.random() * 500),
            MAX_RETRY_DELAY_MS, current.sendBy! - now());
          current.state = "requested";
          current.nextAttemptAt = now() + delay;
          delete current.owner;
          current.updatedAt = now();
          return delay;
        }, late);
      } catch (writeError) {
        // The classification was not saved, so nothing carries the run's cause on.
        onError(writeError);
        return report();
      }
      if (next === "not-classified") return report();
      try {
        // A refusal is not a fault, but a fault that joined it still is: it is
        // reported as the run ends.
        if (next === "refused") return await finish(id, { status: "failed", detail: (error as Refusal).message }, late);
        // Handed over before the terminal write, so a failed save keeps it for
        // the expiry written again later. It is reported if the request
        // expires, and never again by this run.
        const settled = settle();
        if (settled) handOver(id, settled.cause);
        handed = id;
        if (next === "expired") return await finish(id, "expired", late);
        // This operation wakes itself for its retry; other conversations keep running.
        armRetry(id, next);
      } catch (writeError) { onError(writeError); }
    } finally {
      ended = true;
      for (const fault of joined.splice(0)) onError(fault);
    }
  }
  return { reconcile, stop() {
    lifetime.end();
    for (const timer of retries.values()) timers.clearTimeout(timer);
    retries.clear();
    // Requests waiting here go on in the next instance, which never sees the
    // causes they carry, so they are reported now.
    for (const cause of causes.values()) onError(cause);
    causes.clear();
  },
  // Resolves once the runs in flight now have ended, including those a stopped
  // worker is still finishing, so a caller can see what they left behind.
  idle: () => Promise.all([...active.values()]).then(() => {}) };
}
