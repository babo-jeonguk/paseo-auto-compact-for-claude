import type { Row } from "../shared/rpc";
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
  skip?: { id: string; dueAt: number; sessionId: string };
  activityKey?: string;
  sessionId?: string;
}
export interface State {
  version: 1;
  disabled: string[];
  jobs: Job[];
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
    expected?: Observation
  ): Promise<{ status: "completed" | "failed" | "unknown"; detail: string }>;
  /** Automatic dispatch observes native activity; TTL may use the disclosed default. */
  readiness?: (expected: Observation, dueAt?: number) => Promise<string | null>;
  automatic?: (
    expected: Observation,
    guard?: DispatchGuard
  ) => Promise<{ status: "completed" | "failed" | "unknown"; detail: string }>;
}
