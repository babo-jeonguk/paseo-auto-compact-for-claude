import { createHash, randomUUID } from "node:crypto";
import { operationRowStatus, operationPending, type CompactOperation, type CompactTarget } from "../shared/rpc";
import type { CompactOutcome, Gateway, State, StateStore, StoredOperation } from "./model";
import type { Settings } from "../shared/settings";
import { bounded } from "./deadline";

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

export function operationStatus(operation: CompactOperation) {
  return operationRowStatus(operation);
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


export const OPERATION_TIMEOUT_MS = 180_000;
const LEASE_MS = 30_000;
const INSPECT_TIMEOUT_MS = 5_000;
const MAX_PRE_SEND_ATTEMPTS = 3;

function project(state: State, operation: StoredOperation) {
  const job = state.jobs.find(job => job.operationId === operation.id);
  if (job) {
    job.status = operationStatus(operation);
    job.detail = operation.result?.message ?? "Compaction requested; waiting for completed compaction boundary";
  }
}

export function recoverOperations(state: State, now: number) {
  for (const operation of state.operations) {
    if (!operationPending(operation)) continue;
    if (operation.deadlineAt === undefined) {
      // First-stage operations did not persist dispatch evidence. Never infer
      // non-delivery from the absence of fields in an older state file.
      operation.state = "unknown";
      operation.result = { code: "interrupted", message: "Plugin restarted during compaction; no automatic retry" };
    } else {
      operation.state = operation.evidence?.dispatchStartedAt !== undefined ? "observing" : "requested";
    }
    delete operation.leaseOwner;
    delete operation.leaseUntil;
    operation.updatedAt = now;
    project(state, operation);
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
  const outcomes = new Map<string, CompactOutcome>();
  let running = false, stopped = false;
  async function finish(id: string, outcome: CompactOutcome | "expired") {
    await update(state => {
      const operation = state.operations.find(entry => entry.id === id);
      if (stopped || !operation || !operationPending(operation) || operation.leaseOwner !== owner) return;
      operation.state = outcome === "expired" ? "expired" : outcome.status === "completed" ? "succeeded" : outcome.status;
      operation.result = outcome === "expired"
        ? { code: "expired_before_dispatch", message: "Compaction request expired before dispatch" }
        : { code: outcome.status, message: outcome.detail };
      operation.updatedAt = now();
      delete operation.leaseOwner;
      delete operation.leaseUntil;
      project(state, operation);
    });
    outcomes.delete(id);
  }
  async function reconcile(connected = true) {
    if (stopped || running) return;
    running = true;
    let claimedId: string | undefined;
    try {
      const candidate = (await store.read()).operations.find(operationPending);
      if (!candidate) return;
      if (!outcomes.has(candidate.id) && now() < (candidate.nextAttemptAt ?? 0) && now() < (candidate.deadlineAt ?? 0)) return;
      // Expiry and retained local outcomes can progress even before host attach.
      if (!connected && !outcomes.has(candidate.id) && !candidate.evidence?.boundary && now() < (candidate.deadlineAt ?? 0)) return;
      const operation = await update(state => {
        const current = state.operations.find(entry => entry.id === candidate.id);
        if (stopped || !current || !operationPending(current)) return null;
        if (current.leaseOwner && current.leaseOwner !== owner && (current.leaseUntil ?? 0) > now()) return null;
        current.leaseOwner = owner;
        current.leaseUntil = Math.min(now() + LEASE_MS, current.deadlineAt ?? now());
        current.updatedAt = now();
        if (current.evidence?.dispatchStartedAt === undefined && !outcomes.has(current.id)) {
          current.state = "dispatching";
          current.attempt = (current.attempt ?? 0) + 1;
        }
        project(state, current);
        return structuredClone(current);
      });
      if (!operation) return;
      claimedId = operation.id;
      const remembered = outcomes.get(operation.id);
      if (remembered) { await finish(operation.id, remembered); return; }
      if (operation.evidence?.dispatchStartedAt !== undefined) {
        let result: CompactOutcome | null = null;
        if (gateway.inspect && (connected || operation.evidence?.boundary)) {
          try { result = await bounded(gateway.inspect(operation), INSPECT_TIMEOUT_MS); }
          catch (error) { onError(error); }
        }
        if (result && result.status !== "unknown") { outcomes.set(operation.id, result); await finish(operation.id, result); return; }
        if (result?.status === "unknown" || now() >= (operation.deadlineAt ?? 0)) {
          const outcome = result ?? { status: "unknown", detail: "Compaction deadline passed without matching completion evidence; no automatic retry" };
          outcomes.set(operation.id, outcome);
          await finish(operation.id, outcome);
        }
        return;
      }
      if (now() >= (operation.deadlineAt ?? 0) || now() > (operation.deliveryExpiresAt ?? Infinity)) {
        await finish(operation.id, "expired"); return;
      }
      if ((operation.attempt ?? 0) > MAX_PRE_SEND_ATTEMPTS) {
        const outcome: CompactOutcome = { status: "failed", detail: "Pre-dispatch attempt budget exhausted; nothing sent" };
        outcomes.set(operation.id, outcome); await finish(operation.id, outcome); return;
      }
      const deadlineAt = operation.deadlineAt!;
      const wait = <T>(work: Promise<T>) => bounded(work, Math.min(INSPECT_TIMEOUT_MS, deadlineAt - now()));
      const [agent, config] = await Promise.all([wait(gateway.refresh(operation.agentId)), wait(settings())]);
      const allowed = async () => {
        const [latest, state] = await Promise.all([wait(settings()), store.read()]);
        const endedAt = operation.reservationEndedAt;
        if (stopped || !agent || !latest || !latest.enabled || latest.disabledProviders.includes(agent.provider) ||
            state.disabled.includes(operation.agentId) || agent.tokens === null || agent.tokens < latest.threshold ||
            endedAt === undefined) return false;
        const due = endedAt + latest.idleMinutes * 60_000;
        return now() >= due && now() <= due + 5 * 60_000 && now() <= (operation.deliveryExpiresAt ?? Infinity);
      };
      if (stopped) return;
      if (!config || !agent?.eligible || !agent.idle || !sameActivity(operation, agent) ||
          operation.target.sessionId !== agent.sessionId ||
          operation.target.activityKey !== (agent.activityKey ?? null) ||
          (operation.kind === "automatic" && (!gateway.automatic || !await allowed()))) {
        const outcome: CompactOutcome = { status: "failed", detail: "Session, activity or policy changed before dispatch; nothing sent" };
        outcomes.set(operation.id, outcome); await finish(operation.id, outcome); return;
      }
      const execution = {
        id: operation.id, deadlineAt,
        current: () => !stopped && now() < deadlineAt,
        checkpoint: async (evidence: NonNullable<StoredOperation["evidence"]>) => {
          await update(state => {
            const current = state.operations.find(entry => entry.id === operation.id);
            if (stopped || !current || !operationPending(current) || current.leaseOwner !== owner || now() >= deadlineAt)
              throw new Error("Compaction worker ownership expired");
            current.evidence = { ...current.evidence, ...evidence,
              invalidated: !!current.evidence?.invalidated || !!evidence.invalidated };
            if (current.evidence.dispatchStartedAt !== undefined) current.state = "observing";
            current.updatedAt = now();
            current.leaseUntil = Math.min(now() + LEASE_MS, deadlineAt);
          });
        },
      };
      const outcome = await (operation.kind === "automatic"
        ? gateway.automatic!(agent, { expiresAt: Math.min(operation.deliveryExpiresAt ?? Infinity, deadlineAt), allowed }, execution)
        : gateway.compact(agent.agentId, agent, execution));
      if (stopped) return;
      if (outcome.status === "unknown") {
        const saved = (await store.read()).operations.find(entry => entry.id === operation.id);
        if (saved?.evidence?.dispatchStartedAt !== undefined && !saved.evidence.invalidated && now() < deadlineAt)
          return; // Ambiguous delivery continues through evidence reconciliation.
      }
      outcomes.set(operation.id, outcome);
      await finish(operation.id, outcome);
    } catch (error) {
      // Keep the durable nonterminal record. The next reconcile retries state
      // persistence or pre-send inspection; it never retransmits marked work.
      onError(error);
      if (claimedId && !outcomes.has(claimedId) && !stopped) {
        try {
          await update(state => {
            const current = state.operations.find(entry => entry.id === claimedId);
            if (!current || !operationPending(current) || current.leaseOwner !== owner ||
                current.evidence?.dispatchStartedAt !== undefined) return;
            if ((current.attempt ?? 0) >= MAX_PRE_SEND_ATTEMPTS) {
              current.state = "failed";
              current.result = { code: "pre_dispatch_retries_exhausted", message: "Could not prepare compaction; nothing sent" };
            } else {
              current.state = "requested";
              const delay = 1_000 * 2 ** Math.max(0, (current.attempt ?? 1) - 1);
              current.nextAttemptAt = now() + delay + Math.floor(Math.random() * 500);
            }
            delete current.leaseOwner; delete current.leaseUntil;
            current.updatedAt = now(); project(state, current);
          });
        } catch (writeError) { onError(writeError); }
      }
    } finally { running = false; }
  }
  return { reconcile, stop() { stopped = true; } };
}
