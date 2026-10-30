import { z } from "zod";
import { CompactOperationSchema, StatusSchema, type CompactTarget, type Row } from "../shared/rpc";
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
  // The observer exists but could not be read just now (see observer.read).
  observerUnreadable?: boolean;
  // The host reopens this session before its next prompt, because a plugin
  // instance before this one started its observer (Paseo 0.14). Until an
  // ordinary message has done that, nothing is compacted there.
  resumeRequired?: boolean;
}
export const SESSION_RESUME_REQUIRED = "Session must resume after plugin reload; send a message before compacting";
// Schemas are the one definition of stored records; the store validates with
// them and the types below are inferred from them.
export const JobSchema = z.object({
  agentId: z.string(),
  revision: z.string(),
  endedAt: z.number().finite(),
  status: StatusSchema,
  detail: z.string(),
  attemptedAt: z.number().finite().optional(),
  operationId: z.string().optional(),
  skip: z.object({ id: z.string().min(1), dueAt: z.number().finite(), sessionId: z.string().min(1) }).optional(),
  activityKey: z.string().optional(),
  sessionId: z.string().optional(),
});
export type Job = z.infer<typeof JobSchema>;
export const NativeOperationSchema = z.object({ id: z.string(), launchId: z.string(), generation: z.string(),
  sessionId: z.string().nullable(), revision: z.number().int() });
export type NativeOperation = z.infer<typeof NativeOperationSchema>;
export const OperationEvidenceSchema = z.object({
  native: NativeOperationSchema.optional(),
  dispatchStartedAt: z.number().finite().optional(),
  turnId: z.string().optional(),
  boundary: z.boolean().optional(),
  invalidated: z.boolean().optional(),
});
export type OperationEvidence = z.infer<typeof OperationEvidenceSchema>;
export interface ExecutionContext {
  id: string;
  // The dispatch marker must be written by this time (see deadline.ts).
  sendBy: number;
  checkpoint(evidence: OperationEvidence): Promise<void>;
  current(): boolean;
}
// "failed" never says whether anything was sent; the persisted dispatch marker does.
export type CompactOutcome = { status: "completed" | "failed" | "unknown"; detail: string };
// A condition that makes sending wrong, not a fault: the attempt ends without
// retry. Any other error before the dispatch marker is a fault, retried until
// the send deadline. The worker alone makes this distinction.
export class Refusal extends Error {}

// Displays may show an unreadable observer as none; dispatch must not act on
// that, so it throws a fault to retry instead.
export function readable<T extends Observation | null>(agent: T): T {
  if (agent?.observerUnreadable) throw new Error("Claude observer could not be read");
  return agent;
}

export const targetOf = (agent: Pick<Observation, "sessionId" | "activityKey">): CompactTarget =>
  ({ sessionId: agent.sessionId, activityKey: agent.activityKey ?? null });
// The one test that a conversation is still exactly the one work was accepted
// for: same host revision, Claude session and native activity.
export const unchanged = (expected: { revision: string | null; target: CompactTarget }, agent: Observation) =>
  expected.revision === agent.revision && expected.target.sessionId === agent.sessionId &&
  expected.target.activityKey === (agent.activityKey ?? null);
export const StoredOperationSchema = CompactOperationSchema.extend({
  // Canonical caller input; null identifies legacy records with no request token contract.
  inputFingerprint: z.string().nullable(),
  // The dispatch marker must be written by this time (see deadline.ts).
  sendBy: z.number().finite().optional(),
  deliveryExpiresAt: z.number().finite().optional(),
  reservationEndedAt: z.number().finite().optional(),
  attempt: z.number().int().nonnegative().optional(),
  nextAttemptAt: z.number().finite().optional(),
  // The worker that claimed it last; checkpoints from any earlier worker fail.
  owner: z.string().optional(),
  evidence: OperationEvidenceSchema.optional(),
});
export type StoredOperation = z.infer<typeof StoredOperationSchema>;
// Version 1 with additive fields: v1.0.2 drops what it does not know and keeps
// working. Bump the version only for a change older readers would misread.
export interface State {
  version: 1;
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
// `compact` and `automatic` return an outcome only once the dispatch marker is
// written. Before it they throw: a Refusal when a reading shows sending would be
// wrong, anything else when it could not be checked.
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
  /** Retire a finished operation's native request; best effort. */
  release?: (operation: StoredOperation) => Promise<void>;
}
