import type { State, StoredOperation } from "./model";
import { publicOperation } from "./operations";

// JSON with object keys in sorted order, so two records with the same fields in
// a different key order serialize alike. The store reads records from a file,
// whose key order this release does not control.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  });
}

// Every field the operation RPC returns is shown except updatedAt, which the
// worker moves while an operation is worked on. The fields the store keeps only
// for the worker are not in the projection at all, so saving them must not make
// a screen read again.
function shownOperation(operation: StoredOperation) {
  const shown: Partial<ReturnType<typeof publicOperation>> = { ...publicOperation(operation) };
  delete shown.updatedAt;
  return shown;
}

function shown(state: State, agentId: string): string {
  return canonical({
    disabled: state.disabled.includes(agentId),
    // A conversation's reservation is shown as a whole, so every field counts.
    jobs: state.jobs.filter(job => job.agentId === agentId),
    operations: state.operations
      .filter(operation => operation.agentId === agentId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(shownOperation),
  });
}

// The conversations whose shown state differs between two saved states, or
// null when what was saved before is not known.
export function changedConversations(before: State | null, after: State): string[] | null {
  if (!before) return null;
  const ids = new Set<string>();
  for (const state of [before, after]) {
    for (const id of state.disabled) ids.add(id);
    for (const job of state.jobs) ids.add(job.agentId);
    for (const operation of state.operations) ids.add(operation.agentId);
  }
  return [...ids].filter(id => shown(before, id) !== shown(after, id)).sort();
}

type StateEvent = { agentId: string | null; revision: number };
type Context = {
  push(event: StateEvent): Promise<void>;
  signal: AbortSignal;
};
interface Subscriber extends Context {
  agentId?: string;
  onAbort: () => void;
}

export type StateChanges = {
  saved(before: State | null, after: State): void;
  settingsChanged(): void;
  subscribe(input: { agentId?: string }, context: Context): void;
  stop(): void;
};

export function createStateChanges(): StateChanges {
  // One revision per plugin instance, so events from one instance can be told
  // apart and ordered. It starts again when the plugin restarts; nothing reads
  // it as a version of the state, which screens always read again in full.
  let revision = 0;
  let stopped = false;
  const subscribers = new Set<Subscriber>();

  function send(subscriber: Subscriber, event: StateEvent) {
    // The subscriber is gone or disconnected. Its screen falls back to its
    // safety poll, and a push failure is not a defect of the plugin's state.
    void Promise.resolve(subscriber.push(event)).catch(() => {});
  }

  function publish(events: StateEvent["agentId"][]) {
    if (stopped || events.length === 0) return;
    // Every event of one save shares the revision it moved on to, so a screen
    // reading after the save sees one coherent change.
    revision++;
    for (const subscriber of [...subscribers]) {
      for (const agentId of events) {
        // A subscription narrowed to one conversation skips the others'
        // events; the null event ("read everything") always reaches it.
        if (agentId !== null && subscriber.agentId !== undefined && subscriber.agentId !== agentId) continue;
        send(subscriber, { agentId, revision });
      }
    }
  }

  return {
    saved(before, after) {
      const changed = changedConversations(before, after);
      // Without the state it replaced, anything may have changed.
      if (changed === null) publish([null]);
      else publish(changed);
    },
    settingsChanged() {
      publish([null]);
    },
    subscribe(input, { push, signal }) {
      if (stopped || signal.aborted) return;
      const subscriber: Subscriber = { agentId: input.agentId, push, signal, onAbort: () => {} };
      subscriber.onAbort = () => subscribers.delete(subscriber);
      subscribers.add(subscriber);
      signal.addEventListener("abort", subscriber.onAbort, { once: true });
      // A subscription made again after a reconnect starts by asking its screen
      // to read everything, because the host replays nothing missed. It carries
      // the current revision without moving it on.
      send(subscriber, { agentId: null, revision });
    },
    stop() {
      stopped = true;
      for (const subscriber of subscribers)
        subscriber.signal.removeEventListener("abort", subscriber.onAbort);
      subscribers.clear();
    },
  };
}
