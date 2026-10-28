import type { CompactOperation, Row } from "../shared/rpc";
import type { CacheWindow } from './cache';

export type Status = Row["status"];
export interface Observation {
  agentId: string;
  title: string | null;
  workspace: string;
  provider: string;
  revision: string | null;
  tokens: number | null;
  eligible: boolean;
  idle: boolean;
  busyReason?: Row['busyReason'];
  inputIdleSince?: number | null;
  sessionId: string | null;
  activityKey?: string | null;
  observedEndedAt?: number | null;
  cache?: CacheWindow | null;
}
export interface Job {
  agentId: string;
  revision: string;
  endedAt: number;
  status: Status;
  detail: string;
  attemptedAt?: number;
  operationId?: string;
  skip?: { id: string; dueAt: number; sessionId: string };
  activityKey?: string;
  sessionId?: string;
}
export interface NativeOperation {
  id: string;
  launchId: string;
  generation: string;
  sessionId: string | null;
  revision: number;
}
export interface OperationEvidence {
  native?: NativeOperation;
  dispatchStartedAt?: number;
  turnId?: string;
  boundary?: boolean;
  turnCompleted?: boolean;
  invalidated?: boolean;
}
export interface ExecutionContext {
  id: string;
  deadlineAt: number;
  checkpoint(evidence: OperationEvidence): Promise<void>;
  current(): boolean;
}
export type CompactOutcome = { status: "completed" | "failed" | "unknown"; detail: string };
export interface StoredOperation extends CompactOperation {
  // Canonical caller input; null identifies legacy records with no request token contract.
  inputFingerprint: string | null;
  deadlineAt?: number;
  deliveryExpiresAt?: number;
  reservationEndedAt?: number;
  attempt?: number;
  nextAttemptAt?: number;
  leaseOwner?: string;
  leaseUntil?: number;
  evidence?: OperationEvidence;
}
export interface State {
  version: 2;
  disabled: string[];
  jobs: Job[];
  operations: StoredOperation[];
}
export interface StateStore {
  read(): Promise<State>;
  write(state: State): Promise<void>;
}
export interface DispatchGuard {
  expiresAt: number;
  allowed(): Promise<boolean>;
}
export interface Gateway {
  list(): Promise<Observation[]>;
  refresh(agentId: string): Promise<Observation | null>;
  compact(
    agentId: string,
    expected?: Observation,
    execution?: ExecutionContext
  ): Promise<CompactOutcome>;
  /** Automatic dispatch observes native activity; TTL may use the disclosed default. */
  readiness?: (expected: Observation, dueAt?: number) => Promise<string | null>;
  automatic?: (
    expected: Observation,
    guard?: DispatchGuard,
    execution?: ExecutionContext
  ) => Promise<CompactOutcome>;
  inspect?: (operation: StoredOperation) => Promise<CompactOutcome | null>;
}
