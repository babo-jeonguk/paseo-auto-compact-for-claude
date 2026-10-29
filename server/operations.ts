import { createHash, randomUUID } from "node:crypto";
import { finishedState, operationRowStatus, operationPending, type CompactOperation, type CompactTarget } from "../shared/rpc";
import { readable, unchanged, type CompactOutcome, type Gateway, type State, type StateStore, type StoredOperation } from "./model";
import type { Settings } from "../shared/settings";
import { bounded, deadlineOf, inspect, INSPECT_TIMEOUT_MS, OBSERVATION_MS } from "./deadline";
import { automaticBlock } from "./policy";

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

const MAX_PRE_SEND_ATTEMPTS = 3;
const budgetSpent = (failedAttempts: number) => failedAttempts >= MAX_PRE_SEND_ATTEMPTS;

type Ending = CompactOutcome | "expired" | "exhausted";
function resultOf(ending: Ending, dispatched: boolean): NonNullable<StoredOperation["result"]> {
  if (ending === "expired") return { code: "expired_before_dispatch", message: "Compaction request expired before dispatch" };
  if (ending === "exhausted") return { code: "pre_dispatch_retries_exhausted", message: "Could not prepare compaction; nothing sent" };
  const code = ending.status === "completed" ? "completed" : ending.status === "unknown" ? "unknown"
    : dispatched ? "failed_after_dispatch" : "failed_before_dispatch";
  return { code, message: ending.detail };
}
const stateOf = (ending: Ending): StoredOperation["state"] =>
  finishedState(ending === "expired" ? "expired" : ending === "exhausted" ? "failed" : ending.status);

export function recoverOperations(state: State, now: number) {
  for (const operation of state.operations) {
    if (!operationPending(operation)) continue;
    operation.state = operation.evidence?.dispatchStartedAt !== undefined ? "observing" : "requested";
    delete operation.owner;
    operation.updatedAt = now;
  }
}

// This module owns execution/recovery; the scheduler supplies its one state
// transaction queue so reservation changes and worker checkpoints cannot race.
export function createOperationWorker(options: {
  store: StateStore;
  update<T>(change: (state: State) => T): Promise<T>;
  gateway: Gateway;
  settings(): Promise<Settings | null>;
  now(): number;
  onError(error: unknown): void;
}) {
  const { store, update, gateway, settings, now, onError } = options;
  const owner = randomUUID();
  // Outcomes whose terminal write failed; they are written again, never re-earned.
  const outcomes = new Map<string, Ending>();
  let running = false, again = false, stopped = false, lastConnected = true;
  async function finish(id: string, ending: Ending) {
    outcomes.set(id, ending);
    await update(state => {
      const operation = state.operations.find(entry => entry.id === id);
      if (stopped || !operation || !operationPending(operation) || operation.owner !== owner) return;
      operation.state = stateOf(ending);
      operation.result = resultOf(ending, operation.evidence?.dispatchStartedAt !== undefined);
      operation.updatedAt = now();
      delete operation.owner;
    });
    outcomes.delete(id);
  }
  // A request that arrives during a pass runs another pass right after it, so
  // a new operation never waits for the next tick. Callers do not wait for a
  // pass someone else started.
  async function reconcile(connected = true) {
    lastConnected = connected;
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; await pass(lastConnected); } while (again && !stopped);
    } finally { running = false; }
  }
  async function pass(connected: boolean) {
    let claimedId: string | undefined;
    try {
      const candidate = (await store.read()).operations.find(operationPending);
      if (!candidate) return;
      if (!outcomes.has(candidate.id) && now() < (candidate.nextAttemptAt ?? 0) && now() < deadlineOf(candidate)) return;
      // Expiry and retained local outcomes can progress even before host attach.
      if (!connected && !outcomes.has(candidate.id) && !candidate.evidence?.boundary && now() < deadlineOf(candidate)) return;
      // Startup recovery clears owners, so a claim only ever replaces an earlier
      // worker of this process; that worker's later checkpoints then fail.
      const operation = await update(state => {
        const current = state.operations.find(entry => entry.id === candidate.id);
        if (stopped || !current || !operationPending(current)) return null;
        current.owner = owner;
        current.updatedAt = now();
        if (current.evidence?.dispatchStartedAt === undefined && !outcomes.has(current.id)) {
          current.state = "dispatching";
          current.attempt = (current.attempt ?? 0) + 1;
        }
        return structuredClone(current);
      });
      if (!operation) return;
      claimedId = operation.id;
      const remembered = outcomes.get(operation.id);
      if (remembered) return await finish(operation.id, remembered);
      if (operation.evidence?.dispatchStartedAt !== undefined) {
        let result: CompactOutcome | null = null;
        if (gateway.inspect && (connected || operation.evidence?.boundary)) {
          try { result = await bounded(gateway.inspect(operation), INSPECT_TIMEOUT_MS); }
          catch (error) { onError(error); }
        }
        if (result) return await finish(operation.id, result);
        if (now() >= deadlineOf(operation)) return await finish(operation.id,
          { status: "unknown", detail: "Compaction deadline passed without matching completion evidence; no automatic retry" });
        return;
      }
      // Sending must start by this time; observation then has its own deadline.
      const sendBy = operation.deadlineAt!;
      if (now() >= sendBy || now() > (operation.deliveryExpiresAt ?? Infinity))
        return await finish(operation.id, "expired");
      // This claim is attempt N; N - 1 earlier attempts failed.
      if (budgetSpent((operation.attempt ?? 0) - 1)) return await finish(operation.id, "exhausted");
      const wait = <T>(work: Promise<T>) => inspect(work, sendBy, now());
      // Reading nothing is not evidence of change: an unreadable host, observer
      // or setting is thrown as a fault and retried; only a reading that shows a
      // change ends the attempt.
      const [agent, config] = await Promise.all([wait(gateway.refresh(operation.agentId)).then(readable), wait(settings())]);
      if (!config) throw new Error("Compact settings could not be read");
      const allowed = async () => {
        const [latest, state] = await Promise.all([wait(settings()), wait(store.read())]);
        if (!latest) throw new Error("Compact settings could not be read");
        return !stopped && !!agent && operation.reservationEndedAt !== undefined &&
          now() <= (operation.deliveryExpiresAt ?? Infinity) &&
          automaticBlock({ agentId: operation.agentId, endedAt: operation.reservationEndedAt,
            settings: latest, disabled: state.disabled, now: now(), agent }) === null;
      };
      if (stopped) return;
      if (!agent?.eligible || !agent.idle || !unchanged(operation, agent) ||
          (operation.kind === "automatic" && (!gateway.automatic || !await allowed())))
        return await finish(operation.id,
          { status: "failed", detail: "Session, activity or policy changed before dispatch; nothing sent" });
      let observeUntil: number | null = null;
      const execution = {
        id: operation.id, deadlineAt: sendBy,
        current: () => !stopped && now() < (observeUntil ?? sendBy),
        checkpoint: async (evidence: NonNullable<StoredOperation["evidence"]>) => {
          await update(state => {
            const current = state.operations.find(entry => entry.id === operation.id);
            if (stopped || !current || !operationPending(current) || current.owner !== owner ||
                now() >= deadlineOf({ ...current, evidence: { ...current.evidence, ...evidence } }))
              throw new Error("Compaction worker ownership expired");
            current.evidence = { ...current.evidence, ...evidence,
              invalidated: !!current.evidence?.invalidated || !!evidence.invalidated };
            if (current.evidence.dispatchStartedAt !== undefined) current.state = "observing";
            current.updatedAt = now();
          });
          if (evidence.dispatchStartedAt !== undefined) observeUntil = evidence.dispatchStartedAt + OBSERVATION_MS;
        },
      };
      // A refusal comes back as a failed outcome; a fault before the dispatch
      // marker is thrown and retried below.
      const outcome = await (operation.kind === "automatic"
        ? gateway.automatic!(agent, { expiresAt: Math.min(operation.deliveryExpiresAt ?? Infinity, sendBy), allowed }, execution)
        : gateway.compact(agent.agentId, agent, execution));
      if (stopped) return;
      if (outcome.status === "unknown") {
        const saved = (await store.read()).operations.find(entry => entry.id === operation.id);
        if (saved?.evidence?.dispatchStartedAt !== undefined && !saved.evidence.invalidated && now() < deadlineOf(saved))
          return; // Ambiguous delivery continues through evidence reconciliation.
      }
      await finish(operation.id, outcome);
    } catch (error) {
      // Keep the durable nonterminal record. The next reconcile retries state
      // persistence or pre-send preparation; it never retransmits marked work.
      onError(error);
      if (claimedId && !outcomes.has(claimedId) && !stopped) {
        try {
          await update(state => {
            const current = state.operations.find(entry => entry.id === claimedId);
            if (!current || !operationPending(current) || current.owner !== owner ||
                current.evidence?.dispatchStartedAt !== undefined) return;
            if (budgetSpent(current.attempt ?? 0)) {
              current.state = stateOf("exhausted");
              current.result = resultOf("exhausted", false);
            } else {
              current.state = "requested";
              const delay = 1_000 * 2 ** Math.max(0, (current.attempt ?? 1) - 1);
              current.nextAttemptAt = now() + delay + Math.floor(Math.random() * 500);
            }
            delete current.owner;
            current.updatedAt = now();
          });
        } catch (writeError) { onError(writeError); }
      }
    }
  }
  return { reconcile, stop() { stopped = true; } };
}
