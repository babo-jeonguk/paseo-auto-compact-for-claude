import { operationPending } from "../shared/rpc";
import type { State, StoredOperation } from "./model";

export const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const HISTORY_SWEEP_INTERVAL_MS = 60 * 60_000;
const BATCH_SIZE = 100;

export interface OperationReceipts {
  remove(agentId: string, operationId: string): Promise<void>;
  sweep(retained: readonly StoredOperation[], cutoff: number): Promise<void>;
}

// The caller holds the scheduler's state queue throughout cleanup and commit.
// Delete evidence first: a failed commit leaves the outcome queryable and the
// next pass repeats an idempotent receipt removal. Pending work never qualifies.
export async function pruneOperationHistory(
  state: State, now: number, receipts: OperationReceipts, onError: (error: unknown) => void
) {
  const cutoff = now - HISTORY_RETENTION_MS;
  const expired = state.operations.filter(operation => !operationPending(operation) &&
    Math.max(operation.createdAt, operation.updatedAt) <= cutoff).slice(0, BATCH_SIZE);
  const removed = new Set<string>();
  for (const operation of expired) {
    try {
      await receipts.remove(operation.agentId, operation.id);
      removed.add(operation.id);
    } catch (error) { onError(error); }
  }
  state.operations = state.operations.filter(operation => !removed.has(operation.id));
  for (const job of state.jobs) {
    if (!job.operationId || !removed.has(job.operationId)) continue;
    // Keep the last activity's guard, not an indefinitely queryable operation
    // ID/outcome. syncJobs has already set attemptedAt only if it may have sent.
    // New native activity replaces this projection.
    const operation = expired.find(operation => operation.id === job.operationId)!;
    job.sessionId ??= operation.target.sessionId ?? undefined;
    job.activityKey ??= operation.target.activityKey ?? undefined;
    delete job.operationId;
    job.detail = "Compaction history for this activity expired";
  }
  return { changed: removed.size > 0, backlog: expired.length === BATCH_SIZE || removed.size < expired.length };
}
