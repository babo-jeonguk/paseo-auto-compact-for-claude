import type { CompactTarget } from "../shared/rpc";

export interface CompactSubmission {
  agentId: string;
  revision: string;
  operationId: string;
  target?: CompactTarget;
}

// These are correlation IDs, not authentication tokens. Native hosts without
// Web Crypto still need stable IDs; collision resistance also uses random bytes.
function operationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sameInput = (a: Omit<CompactSubmission, "operationId">, b: Omit<CompactSubmission, "operationId">) =>
  a.revision === b.revision && a.target?.sessionId === b.target?.sessionId &&
  a.target?.activityKey === b.target?.activityKey;

export function createCompactSubmissions(makeId: () => string = operationId) {
  const pending = new Map<string, CompactSubmission>();
  const key = (hostId: string, agentId: string) => JSON.stringify([hostId, agentId]);
  return {
    get: (hostId: string, agentId: string) => pending.get(key(hostId, agentId)),
    // The same input retries an unconfirmed submission under its ID; different
    // input is a new intent and gets a new ID. A late copy of the replaced one is
    // refused by the server's revision check, and anything it already started
    // blocks this one, so neither can send twice.
    prepare(hostId: string, input: Omit<CompactSubmission, "operationId">) {
      const scope = key(hostId, input.agentId);
      const existing = pending.get(scope);
      if (existing && sameInput(existing, input)) return existing;
      const submission = { ...input, operationId: makeId() };
      pending.set(scope, submission);
      return submission;
    },
    acknowledge(hostId: string, agentId: string, id: string) {
      const scope = key(hostId, agentId);
      if (pending.get(scope)?.operationId === id) pending.delete(scope);
    },
  };
}

// Survives controls closing/remounting, but not an application restart. Server
// active/latest operation projections recover accepted work after a restart.
export const compactSubmissions = createCompactSubmissions();
