import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationWorker, leftoverRetirement, recoverOperations } from "./operations";
import { createQueue } from "./queue";
import { TICK_INTERVAL_MS } from "./scheduler";
import { dueAt } from "./policy";
import { changes } from "../tests/support/changes";
import { fakeTimers } from "../tests/support/timers";
import { cleanupScope } from "../tests/support/scope";
import { drainer } from "../tests/support/drained";
import { defects } from "../tests/support/defects";
import { gate, type Gate } from "../tests/support/gate";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import { DeadlineExceeded, Stopped } from "./deadline";
import { Refusal, type CompactOutcome, type ExecutionContext, type Gateway, type Observation,
  type State, type StoredOperation } from "./model";

type Evidence = CompactOutcome | null | ((operation: StoredOperation) => CompactOutcome | null);
type Hook = (execution: ExecutionContext) => Promise<CompactOutcome>;

function fixture(options: { agents?: string[] } = {}) {
  let time = 1000;
  const observations: Record<string, Observation> = {};
  for (const id of options.agents ?? ["a"]) {
    observations[id] = { agentId: id, revision: "rev", sessionId: id === "a" ? "native" : `native-${id}`,
      activityKey: id === "a" ? "activity" : `activity-${id}`,
      title: null, workspace: "/work", provider: "claude", tokens: 100, eligible: true, idle: true };
  }
  const sessionOf = (id: string) => observations[id].sessionId;
  const operation = (id: string, agentId: string): StoredOperation => ({
    id, agentId, revision: "rev",
    target: { sessionId: sessionOf(agentId), activityKey: observations[agentId].activityKey ?? null },
    kind: "manual", state: "requested", createdAt: time, updatedAt: time, result: null,
    inputFingerprint: `fingerprint-${id}`, sendBy: time + 180_000, attempt: 0,
  });
  let state: State = { version: 1, disabled: [], jobs: [],
    operations: (options.agents ?? ["a"]).map(id => operation(`operation-${id}`, id)) };
  let sends = 0, writesFail = false, readsFail = 0;
  let stale: State | null = null;
  const errors: unknown[] = [], calls: string[] = [], events: string[] = [];
  const hooks = new Map<string, Hook>();
  let evidence: Evidence = null;
  // Stored states and recorded events wake tests waiting for them.
  const signal = changes();
  const record = (event: string) => { events.push(event); signal.changed(); };
  // The worker's retry wake-ups run only when a test moves them on.
  const timers = fakeTimers(signal.changed);
  const gateway: Gateway = {
    list: async (observe) => Object.values(observations).forEach(observation => observe(Promise.resolve(observation))),
    refresh: async id => observations[id] ?? null,
    compact: async (id, _expected, execution) => {
      calls.push(id);
      record(`${id}:send`);
      const hook = hooks.get(id);
      if (hook) {
        const outcome = await hook(execution);
        sends++;
        return outcome;
      }
      await execution.checkpoint({ dispatchStartedAt: time });
      sends++;
      return { status: "completed", detail: "matching evidence" };
    },
    inspect: async operation => typeof evidence === "function" ? evidence(operation) : evidence,
  };
  // The scheduler's state queue, as the worker gets it.
  const queue = createQueue();
  // A held transaction is held before it is applied (`queued`), or applied and
  // then held before it returns to the worker; `skip` transactions pass before it.
  let holdUpdate: { skip: number; queued: boolean; reached: () => void; release: Promise<void> } | null = null;
  const holding = async (queued: boolean) => {
    const hold = holdUpdate;
    if (!hold || hold.queued !== queued || hold.skip-- !== 0) return;
    holdUpdate = null;
    hold.reached();
    await hold.release;
  };
  // The first transaction whose change makes the state match `when` is held
  // before it is committed, or after when `after`, or fails with `error` instead.
  let committing: { when: (next: State) => boolean; held?: Gate; after?: boolean; error?: Error } | null = null;
  const update = <T>(change: (state: State) => T): Promise<T> => {
    const result = queue.run(async () => {
      await holding(true);
      const next = structuredClone(state);
      const value = change(next);
      const commit = committing?.when(next) ? committing : null;
      if (commit) {
        committing = null;
        if (commit.error) throw commit.error;
        if (!commit.after) await commit.held?.pass();
      }
      if (writesFail && next.operations[0].state === "succeeded") throw new Error("disk full");
      state = next;
      signal.changed();
      if (commit?.after) await commit.held?.pass();
      await holding(false);
      return value;
    });
    updated?.(result);
    return result;
  };
  // Shown each transaction's result as the worker gets it.
  let updated: ((result: Promise<unknown>) => void) | null = null;
  // The next state read waits for its release before it reads.
  let readHold: ReturnType<typeof gate> | null = null;
  const make = (settings = async (): Promise<Settings | null> => ({ ...DEFAULT_SETTINGS })) => createOperationWorker({ gateway,
    store: { read: async () => {
        const hold = readHold;
        readHold = null;
        if (hold) await hold.pass();
        if (readsFail > 0) { readsFail--; throw new Error("EBUSY"); }
        if (stale) { const value = stale; stale = null; return structuredClone(value); }
        return structuredClone(state);
      }, write: async next => { state = next; signal.changed(); } },
    update, settings, now: () => time, timers,
    // A report wakes the tests waiting for it.
    onError: error => { errors.push(error); signal.changed(); } });
  return { make, gateway, errors, calls, events,
    // Waits until the condition holds after a stored state or a recorded event.
    until: signal.until,
    record,
    timers,
    get agent() { return observations.a; },
    get operation() { return state.operations[0]; },
    operationById(id: string) {
      const found = state.operations.find(entry => entry.id === id);
      assert.ok(found, `missing ${id}`);
      return found;
    },
    get snapshot() { return structuredClone(state); },
    readStaleOnce(value: State) { stale = structuredClone(value); },
    get sends() { return sends; },
    set evidence(value: Evidence) { evidence = value; },
    hook(id: string, work: Hook | null) { if (work) hooks.set(id, work); else hooks.delete(id); },
    set failTerminal(value: boolean) { writesFail = value; },
    set failReads(count: number) { readsFail = count; },
    get time() { return time; },
    // Holds the next transaction, or the one `skip` transactions later, after
    // it is applied, or before when `queued`; `reached` resolves then.
    holdNextUpdate(skip = 0, queued = false): Held {
      let reached!: () => void, release!: () => void;
      const arrived = new Promise<void>(resolve => { reached = resolve; });
      holdUpdate = { skip, queued, reached, release: new Promise<void>(resolve => { release = resolve; }) };
      return { reached: arrived, release };
    },
    // Holds the next state read before it reads.
    holdRead(): Held { readHold = gate(); return readHold; },
    // Holds the first transaction that would commit a state matching `when`,
    // before it commits, or once it has when `after`; `reached` resolves then.
    holdCommit(when: (next: State) => boolean, after = false): Held {
      const held = gate();
      committing = { when, held, after };
      return held;
    },
    // Fails the first transaction that would commit a state matching `when`.
    failCommit(error: Error, when: (next: State) => boolean) { committing = { when, error }; },
    // Calls `hook` with each transaction's result as the worker gets it.
    onUpdate(hook: ((result: Promise<unknown>) => void) | null) { updated = hook; },
    advance(ms: number) { time += ms; },
    recover() { recoverOperations(state, time); },
  };
}

test("durable requested work is dispatched after restart with the original identity", async () => {
  const f = fixture(); f.recover();
  const deadline = f.operation.sendBy;
  await f.make().reconcile();
  assert.equal(f.sends, 1);
  assert.equal(f.operation.state, "succeeded");
  assert.equal(f.operation.sendBy, deadline);
});

test("dispatch marker recovery observes without resending and uses matching evidence", async () => {
  const f = fixture();
  f.operation.state = "dispatching";
  f.operation.evidence = { dispatchStartedAt: 1000 };
  f.recover();
  assert.equal(f.operation.state, "observing");
  const worker = f.make();
  await worker.reconcile();
  assert.equal(f.operation.state, "observing");
  assert.equal(f.sends, 0);
  f.evidence = { status: "completed", detail: "matching persisted evidence" };
  await worker.reconcile();
  assert.equal(f.operation.state, "succeeded");
  assert.equal(f.sends, 0);
});

test("unconfirmed send remains observable until its fixed deadline, never retried", async () => {
  const f = fixture();
  f.gateway.compact = async (_id, _expected, execution) => {
    await execution.checkpoint({ dispatchStartedAt: 1000 });
    return { status: "unknown", detail: "send timed out" };
  };
  const worker = f.make();
  await worker.reconcile();
  assert.equal(f.operation.state, "observing");
  f.advance(179_999); await worker.reconcile();
  assert.equal(f.operation.state, "observing");
  f.advance(1); await worker.reconcile();
  assert.equal(f.operation.state, "unknown");
  assert.equal(f.operation.attempt, 1);
});

test("requested work expires disconnected without dispatch", async () => {
  const f = fixture(), worker = f.make();
  await worker.reconcile(false);
  assert.equal(f.operation.state, "requested");
  f.advance(180_001); await worker.reconcile(false);
  assert.equal(f.operation.state, "expired");
  assert.equal(f.sends, 0);
});

test("terminal persistence is retried in process and from evidence after restart", async () => {
  for (const restart of [false, true]) {
    const f = fixture(); let worker = f.make();
    f.failTerminal = true;
    await worker.reconcile();
    assert.equal(f.operation.state, "observing");
    assert.equal(f.sends, 1);
    assert.equal(f.errors.length, 1);
    f.failTerminal = false;
    if (restart) {
      worker.stop(); f.recover(); worker = f.make();
      f.evidence = { status: "completed", detail: "durable native receipt + boundary" };
    }
    await worker.reconcile();
    assert.equal(f.operation.state, "succeeded");
    assert.equal(f.sends, 1);
  }
});

test("faults before the dispatch marker are retried with persisted backoff until the send deadline, then expire unsent", async () => {
  const f = fixture(), worker = f.make();
  f.gateway.refresh = async () => { throw new Error("disconnected"); };
  await worker.reconcile();
  assert.equal(f.operation.state, "requested");
  assert.equal(f.operation.attempt, 1);
  await worker.reconcile();
  assert.equal(f.operation.attempt, 1, "the backoff is persisted");
  while (f.operation.state === "requested") { f.advance(30_500); await worker.reconcile(); }
  assert.equal(f.operation.state, "expired");
  assert.equal(f.operation.result?.code, "expired_before_dispatch");
  assert.ok(f.operation.attempt > 3, "the send deadline, not a count, bounds the retries");
  assert.equal(f.sends, 0);
  assert.deepEqual(f.errors.map(String), ["Error: disconnected"], "only the fault that ended the request is reported");
  worker.stop();
});

test("a fault that clears before the send deadline still sends, however many attempts it took", async () => {
  const f = fixture(), worker = f.make();
  const refresh = f.gateway.refresh;
  let faults = 6;
  f.gateway.refresh = async id => { if (faults-- > 0) throw new Error("Claude observer could not be read"); return refresh(id); };
  while (f.operation.state === "requested") { f.advance(20_000); await worker.reconcile(); }
  assert.equal(f.operation.state, "succeeded");
  assert.equal(f.sends, 1);
  worker.stop();
});

test("the worker wakes itself for a retry instead of waiting for the next tick", async (t) => {
  const f = fixture(), worker = f.make();
  cleanupScope(t).defer(() => worker.stop());
  const compact = f.gateway.compact;
  f.gateway.compact = async () => { throw new Error("observer preparation timed out"); };
  await worker.reconcile();
  assert.equal(f.operation.state, "requested");
  const wait = f.operation.nextAttemptAt! - f.time;
  assert.ok(wait > 0 && wait < TICK_INTERVAL_MS, "the retry comes before the next scheduler tick");
  assert.equal(f.timers.pendingWithin(wait), 1, "the failed attempt set its own wake-up");
  f.gateway.compact = compact;
  f.advance(wait);
  await f.timers.tick(wait);
  await f.until(() => f.operation.state === "succeeded");
  assert.equal(f.sends, 1);
});

type Held = { reached: Promise<void>; release(): void };
type Fixture = ReturnType<typeof fixture>;
const NATIVE = { id: "operation-a", launchId: "launch", generation: "gen-1", sessionId: "native", revision: 1 };
// Sends as the gateway does: an attempt whose worker has stopped before its
// send deadline ends with Stopped before the dispatch marker and stops at it
// after, and "a:sent" is recorded only when the send itself happens.
async function send(f: Fixture, execution: ExecutionContext, native = false) {
  if (!execution.current()) throw new Stopped();
  await execution.checkpoint({ dispatchStartedAt: f.time, ...native ? { native: NATIVE } : {} });
  if (!execution.current()) return { status: "unknown" as const, detail: "Worker stopped at dispatch boundary" };
  f.record("a:sent");
  return { status: "completed" as const, detail: "matching evidence" };
}
// An automatic reservation the policy allows now: its idle delay has passed
// and the conversation is over the threshold. The gateway asks the dispatch
// guard again right before sending.
const automatic = (f: Fixture) => {
  f.operation.kind = "automatic";
  f.operation.reservationEndedAt = f.time - dueAt(0, DEFAULT_SETTINGS);
  f.agent.tokens = DEFAULT_SETTINGS.threshold;
  f.gateway.automatic = async (agent, guard, execution) => {
    if (guard && !await guard.allowed()) throw new Refusal("Reservation cancelled or session changed before send");
    return f.gateway.compact(agent.agentId, agent, execution);
  };
};
// A hold armed from inside an earlier step of the run, so it holds the first
// such step after that one, however many came before.
function later(hold: () => Held) {
  let held: Held | undefined, arrive!: () => void;
  const reached = new Promise<void>(resolve => { arrive = resolve; });
  return { arm() { held = hold(); void held.reached.then(arrive); }, held: { reached, release: () => held?.release() } };
}
// Observable steps of the first operation's record, for holding the
// transaction that saves them.
const expired = (next: State) => next.operations[0].state === "expired";
const retrying = (next: State) => next.operations[0].state === "requested" && next.operations[0].nextAttemptAt !== undefined;

// Each await of a run, held: what the worker reaches while the test holds it.
// `met` is a fault the run met before the stop: work already issued, so the
// stop does not make it expected, and it is reported once.
const stopPoints: Record<string, (f: Fixture) => { worker: ReturnType<Fixture["make"]>; held: Held; met?: Error }> = {
  "the scan of pending work": f => ({ worker: f.make(), held: f.holdRead() }),
  "the claim, queued behind another transaction": f => ({ worker: f.make(), held: f.holdNextUpdate(0, true) }),
  "the claim": f => ({ worker: f.make(), held: f.holdNextUpdate() }),
  "a read of the host before sending": f => {
    const held = gate(), refresh = f.gateway.refresh;
    f.gateway.refresh = async id => { await held.pass(); return refresh(id); };
    return { worker: f.make(), held };
  },
  "a read of the settings before sending": f => {
    const held = gate();
    return { worker: f.make(async () => { await held.pass(); return { ...DEFAULT_SETTINGS }; }), held };
  },
  "the dispatch guard's settings read": f => {
    automatic(f);
    const held = gate();
    let reads = 0;
    return { worker: f.make(async () => { if (++reads === 2) await held.pass(); return { ...DEFAULT_SETTINGS }; }), held };
  },
  "the dispatch guard's state read": f => {
    automatic(f);
    const read = later(() => f.holdRead());
    let reads = 0;
    // The guard reads the settings, then the state.
    return { worker: f.make(async () => { if (++reads === 2) read.arm(); return { ...DEFAULT_SETTINGS }; }), held: read.held };
  },
  "the gateway's dispatch guard": f => {
    automatic(f);
    const held = gate();
    let reads = 0;
    return { worker: f.make(async () => { if (++reads === 3) await held.pass(); return { ...DEFAULT_SETTINGS }; }), held };
  },
  "the send": f => {
    const held = gate();
    f.hook("a", async execution => { await held.pass(); return send(f, execution); });
    return { worker: f.make(), held };
  },
  "the dispatch marker's write": f => {
    const write = later(() => f.holdNextUpdate());
    f.hook("a", execution => { write.arm(); return send(f, execution); });
    return { worker: f.make(), held: write.held };
  },
  "the sent call's outcome": f => {
    const held = gate();
    f.hook("a", async execution => { const outcome = await send(f, execution); await held.pass(); return outcome; });
    return { worker: f.make(), held };
  },
  "the state read after an unknown outcome": f => {
    const read = later(() => f.holdRead());
    f.hook("a", async execution => {
      await execution.checkpoint({ dispatchStartedAt: f.time });
      read.arm();
      return { status: "unknown", detail: "Compaction completion unconfirmed" };
    });
    return { worker: f.make(), held: read.held };
  },
  "the outcome's write": f => {
    const write = later(() => f.holdNextUpdate());
    f.hook("a", async execution => {
      const outcome = await send(f, execution, true);
      write.arm();
      return outcome;
    });
    return { worker: f.make(), held: write.held };
  },
  "the native request's release": f => {
    const held = gate();
    f.hook("a", execution => send(f, execution, true));
    f.gateway.release = async operation => { f.record(`${operation.id}:released`); await held.pass(); };
    return { worker: f.make(), held };
  },
  "an inspection after the dispatch marker": f => {
    f.operation.state = "observing";
    f.operation.evidence = { dispatchStartedAt: f.time };
    const held = gate();
    f.gateway.inspect = async () => { await held.pass(); return { status: "completed", detail: "matching evidence" }; };
    return { worker: f.make(), held };
  },
  "a fault's retry write": f => {
    const held = f.holdCommit(retrying, true);
    const met = new Error("disconnected");
    f.hook("a", async () => { throw met; });
    return { worker: f.make(), held, met };
  },
  "the expiry's write after a fault": f => {
    // The classification finds the send deadline passed; held once the expiry is written.
    const held = f.holdCommit(expired, true);
    const met = new Error("disconnected");
    f.hook("a", async () => { f.advance(180_000); throw met; });
    return { worker: f.make(), held, met };
  },
};

// One test each, so a run that outlives its stop fails at the runner's bound
// on its own.
for (const [at, stopAt] of Object.entries(stopPoints)) {
  test(`a worker stopped at ${at} ends the run at once, writes, sends, releases and arms nothing, and reports only a fault met before`, async (t) => {
    const scope = cleanupScope(t);
    const f = fixture();
    const drained = drainer();
    f.gateway.release ??= async operation => { f.record(`${operation.id}:released`); };
    const { worker, held, met } = stopAt(f);
    scope.defer(() => worker.stop());
    const run = worker.reconcile();
    await held.reached;
    // Taken before stop(), so what stop() itself did counts too.
    const state = JSON.stringify(f.snapshot), events = f.events.length, errors = f.errors.length;
    worker.stop();
    assert.equal(f.timers.pending, 0, `${at}: stopping ends every wait and clears its timer`);
    // The run ends while its step is still held; one still waiting fails here,
    // at the runner's bound.
    await run;
    await worker.idle();
    held.release();
    // What the released step does next has run once the queued callbacks have.
    await drained();
    assert.equal(JSON.stringify(f.snapshot), state, `${at}: nothing is written`);
    assert.deepEqual(f.events.slice(events), [], `${at}: nothing is sent or released`);
    assert.deepEqual(defects(f.errors.slice(errors)), met ? [String(met)] : [],
      `${at}: besides the stop, only a fault the run met before it is reported, once`);
    assert.equal(f.timers.pending, 0, `${at}: no wait or wake-up is armed`);
  });
}

// The run resumes a turn after its claim lands, and a stop can come in between,
// as one from a callback queued behind the claim does.
test("a worker stopped as its claim lands starts no host or settings read", async () => {
  const f = fixture();
  const reads: string[] = [];
  f.gateway.refresh = async id => { reads.push(`host ${id}`); return f.agent; };
  const worker = f.make(async () => { reads.push("settings"); return { ...DEFAULT_SETTINGS }; });
  f.onUpdate(result => {
    f.onUpdate(null);
    // Queued once the run waits on the claim, so the stop comes after the
    // claim lands and before the run goes on.
    queueMicrotask(() => void result.then(() => worker.stop()));
  });
  await worker.reconcile();
  await worker.idle();
  assert.equal(f.operation.state, "dispatching", "the claim landed");
  assert.deepEqual(reads, [], "no read started after the stop");
  assert.deepEqual([f.sends, defects(f.errors), f.timers.pending], [0, [], 0]);
});

test("a gateway fault before the dispatch marker is retried; nothing is sent until it passes", async () => {
  const f = fixture(), worker = f.make();
  const compact = f.gateway.compact;
  f.gateway.compact = async () => { throw new Error("observer preparation timed out"); };
  await worker.reconcile();
  assert.equal(f.operation.state, "requested");
  assert.equal(f.operation.attempt, 1);
  assert.equal(f.errors.length, 0, "a fault that is retried is not reported");
  f.gateway.compact = compact;
  f.advance(2000); await worker.reconcile();
  assert.equal(f.operation.state, "succeeded");
  assert.equal(f.sends, 1);
});

test("a stale read cannot skip a faulted operation's retry wait", async () => {
  const f = fixture(), worker = f.make();
  const stale = f.snapshot;
  const compact = f.gateway.compact;
  f.gateway.compact = async () => { throw new Error("observer preparation timed out"); };
  await worker.reconcile();
  assert.equal(f.operation.state, "requested");
  const attempt = f.operation.attempt;
  assert.ok(f.operation.nextAttemptAt! > 1000, "the fault scheduled a retry");
  const calls = f.calls.length;
  f.gateway.compact = compact;
  // This reconcile's snapshot predates the fault, so only the claim can see the wait.
  f.readStaleOnce(stale);
  await worker.reconcile();
  assert.equal(f.calls.length, calls, "the stale snapshot cannot start the retry early");
  assert.equal(f.operation.attempt, attempt, "the faulted attempt is not claimed twice");
  assert.equal(f.operation.state, "requested");
  f.advance(2000);
  await worker.reconcile();
  assert.equal(f.operation.state, "succeeded");
  assert.equal(f.operation.attempt, attempt! + 1);
  worker.stop();
});

test("a refusal ends the attempt without retry and records that nothing was sent", async () => {
  for (const reason of ["Claude is still working", "Compaction already running for this conversation"]) {
    const f = fixture(), worker = f.make();
    f.gateway.compact = async () => { throw new Refusal(reason); };
    await worker.reconcile();
    assert.equal(f.operation.state, "failed", reason);
    assert.equal(f.operation.result?.code, "failed_before_dispatch", reason);
    assert.match(f.operation.result.message, new RegExp(reason), reason);
    assert.equal(f.operation.evidence?.dispatchStartedAt, undefined, reason);
    assert.equal(f.errors.length, 0, "a refusal is not reported as a fault");
  }
});

test("a failure after the dispatch marker is recorded as sent", async () => {
  const f = fixture(), worker = f.make();
  f.gateway.compact = async (_id, _expected, execution) => {
    await execution.checkpoint({ dispatchStartedAt: 1000 });
    return { status: "failed", detail: "Compact turn failed" };
  };
  await worker.reconcile();
  assert.equal(f.operation.state, "failed");
  assert.equal(f.operation.result?.code, "failed_after_dispatch");
});

test("a new worker takes over the claim and fences the earlier one", async () => {
  const f = fixture();
  f.operation.owner = "earlier-worker";
  await f.make().reconcile();
  assert.equal(f.sends, 1);
  assert.equal(f.operation.state, "succeeded");
  assert.equal(f.operation.owner, undefined);
});

test("stopped workers cannot publish late results over recovered operations", async () => {
  const f = fixture(), first = f.make();
  let release!: (outcome: CompactOutcome) => void;
  // Resolves when the send is held.
  let reached!: () => void;
  const reaching = new Promise<void>(resolve => { reached = resolve; });
  f.gateway.compact = async (_id, _expected, execution) => {
    await execution.checkpoint({ dispatchStartedAt: 1000 });
    return new Promise(resolve => { release = resolve; reached(); });
  };
  const running = first.reconcile();
  await reaching;
  first.stop(); f.recover();
  const second = f.make();
  f.evidence = { status: "failed", detail: "native rejection" };
  await second.reconcile();
  release({ status: "completed", detail: "stale worker" });
  await running;
  assert.equal(f.operation.state, "failed");
});

test("restarts cannot extend the send deadline", async () => {
  const f = fixture();
  f.operation.state = "dispatching";
  f.operation.attempt = 7;
  f.advance(180_000);
  f.recover();
  await f.make().reconcile();
  assert.equal(f.operation.state, "expired");
  assert.equal(f.sends, 0);
});

test("checkpointed evidence can finish recovery before host attachment", async () => {
  const f = fixture();
  f.operation.evidence = { dispatchStartedAt: 1000, boundary: true, turnId: "our-turn" };
  f.operation.state = "observing";
  f.evidence = { status: "completed", detail: "durable evidence" };
  await f.make().reconcile(false);
  assert.equal(f.operation.state, "succeeded");
  assert.equal(f.sends, 0);
});

test("a send late in its window is observed for the full time from the dispatch marker", async () => {
  const f = fixture();
  f.operation.sendBy = 1000 + 10_000; // e.g. the end of an automatic delivery window
  f.gateway.compact = async (_id, _expected, execution) => {
    f.advance(9_000);
    await execution.checkpoint({ dispatchStartedAt: 10_000 });
    return { status: "unknown", detail: "send unconfirmed" };
  };
  const worker = f.make();
  await worker.reconcile();
  f.advance(60_000); await worker.reconcile();
  assert.equal(f.operation.state, "observing", "the send deadline no longer ends observation");
  f.evidence = { status: "completed", detail: "matching native receipt" };
  await worker.reconcile();
  assert.equal(f.operation.state, "succeeded");
});

test("observation ends unknown a fixed time after the dispatch marker", async () => {
  const f = fixture();
  f.gateway.compact = async (_id, _expected, execution) => {
    await execution.checkpoint({ dispatchStartedAt: 1000 });
    return { status: "unknown", detail: "send unconfirmed" };
  };
  const worker = f.make();
  await worker.reconcile();
  f.advance(179_999); await worker.reconcile();
  assert.equal(f.operation.state, "observing");
  f.advance(1); await worker.reconcile();
  assert.equal(f.operation.state, "unknown");
});

test("an unreadable observer or settings is retried, never read as a changed session", async () => {
  for (const fault of ["observer", "settings"] as const) {
    const f = fixture();
    if (fault === "observer") f.gateway.refresh = async () => ({ ...f.agent, activityKey: null, observerUnreadable: true });
    await (fault === "settings" ? f.make(async () => null) : f.make()).reconcile();
    assert.equal(f.operation.state, "requested", fault);
    assert.equal(f.operation.attempt, 1, fault);
    assert.equal(f.operation.result, null, fault);
    assert.equal(f.sends, 0, fault);
  }
});

test("a finished operation retires its native request, so it cannot claim a later /compact", async () => {
  const f = fixture();
  const released: string[] = [];
  f.gateway.release = async operation => { released.push(`${operation.id}:${operation.state}`); };
  f.operation.evidence = { native: { id: "operation-a", launchId: "launch", generation: "generation",
    sessionId: "native", revision: 1 }, dispatchStartedAt: 1000 };
  f.operation.state = "observing";
  f.advance(180_000);
  await f.make().reconcile();
  assert.equal(f.operation.state, "unknown");
  assert.deepEqual(released, ["operation-a:unknown"]);
});

test("a fault after the dispatch marker never expires the work as unsent, even past the send deadline", async () => {
  const f = fixture();
  f.gateway.compact = async (_id, _expected, execution) => {
    f.advance(100_000);
    await execution.checkpoint({ dispatchStartedAt: 101_000 });
    f.advance(90_000); // past the send deadline (181 s), inside the observation (281 s)
    f.failReads = 1; // the worker's own read after the outcome fails
    return { status: "unknown", detail: "send unconfirmed" };
  };
  await f.make().reconcile();
  assert.equal(f.operation.state, "observing", "marked work is observed, not expired");
  assert.equal(f.operation.result, null);
  assert.deepEqual(f.errors.map(String), ["Error: EBUSY"]);
});

test("conversations run independently: a held send does not delay another conversation", async () => {
  const f = fixture({ agents: ["a", "b"] });
  let releaseA!: () => void;
  const heldA = new Promise<void>(resolve => { releaseA = resolve; });
  f.hook("a", async execution => {
    await execution.checkpoint({ dispatchStartedAt: 1000 });
    f.record("a:marker");
    await heldA;
    f.record("a:release");
    return { status: "completed", detail: "A completed" };
  });
  const running = f.make().reconcile();
  await f.until(() => f.operationById("operation-b").state === "succeeded");
  assert.equal(f.operationById("operation-a").state, "observing");
  assert.equal(f.sends, 1, "only B has completed its send while A is held");
  assert.ok(f.events.includes("b:send"), "B is sent while A is still held");
  assert.ok(!f.events.includes("a:release"), "A has not been released yet");
  releaseA();
  await running;
  assert.equal(f.operationById("operation-a").state, "succeeded");
  assert.equal(f.sends, 2, "exactly one send per operation");
  assert.deepEqual(f.calls.toSorted(), ["a", "b"]);
});

test("a fault in one conversation is retried without delaying another conversation", async () => {
  const f = fixture({ agents: ["a", "b"] });
  f.hook("a", async () => { throw new Error("observer preparation timed out"); });
  const worker = f.make();
  await worker.reconcile();
  assert.equal(f.operationById("operation-b").state, "succeeded");
  assert.equal(f.operationById("operation-a").state, "requested");
  assert.ok(f.operationById("operation-a").nextAttemptAt! > 1000, "A's retry is scheduled in the future");
  assert.equal(f.operationById("operation-a").evidence?.dispatchStartedAt, undefined, "A sent nothing before its marker");
  assert.equal(f.sends, 1, "only B was sent");
  f.hook("a", null);
  f.advance(2000);
  await worker.reconcile();
  assert.equal(f.operationById("operation-a").state, "succeeded");
  assert.equal(f.operationById("operation-a").evidence?.dispatchStartedAt, 3000);
  assert.equal(f.sends, 2, "A is sent once on its retry");
});

test("an ambiguous send stays observable without delaying another conversation", async () => {
  const f = fixture({ agents: ["a", "b"] });
  f.hook("a", async execution => {
    await execution.checkpoint({ dispatchStartedAt: 1000 });
    return { status: "unknown", detail: "send timed out" };
  });
  const worker = f.make();
  await worker.reconcile();
  assert.equal(f.operationById("operation-a").state, "observing");
  assert.equal(f.operationById("operation-b").state, "succeeded");
  assert.equal(f.operationById("operation-a").attempt, 1);
  f.advance(60_000);
  await worker.reconcile();
  assert.equal(f.operationById("operation-a").state, "observing");
  assert.equal(f.calls.filter(id => id === "a").length, 1, "ambiguous work is never resent");
});

test("overlapping checkpoints and completions of two conversations keep both evidences and results", async () => {
  const f = fixture({ agents: ["a", "b"] });
  let releaseA!: () => void, releaseB!: () => void;
  const gateA = new Promise<void>(resolve => { releaseA = resolve; });
  const gateB = new Promise<void>(resolve => { releaseB = resolve; });
  f.hook("a", async execution => {
    await execution.checkpoint({ dispatchStartedAt: 2000, turnId: "turn-a" });
    f.record("a:checkpointed");
    await gateA;
    return { status: "completed", detail: "A completed" };
  });
  f.hook("b", async execution => {
    await execution.checkpoint({ dispatchStartedAt: 3000, boundary: true });
    f.record("b:checkpointed");
    await gateB;
    return { status: "completed", detail: "B completed" };
  });
  const running = f.make().reconcile();
  await f.until(() => f.events.includes("a:checkpointed") && f.events.includes("b:checkpointed"));
  assert.equal(f.operationById("operation-a").state, "observing");
  assert.equal(f.operationById("operation-b").state, "observing");
  releaseA();
  await f.until(() => f.operationById("operation-a").state === "succeeded");
  assert.equal(f.operationById("operation-b").state, "observing", "B is still held");
  releaseB();
  await running;
  assert.equal(f.operationById("operation-a").state, "succeeded");
  assert.equal(f.operationById("operation-b").state, "succeeded");
  assert.deepEqual(f.operationById("operation-a").evidence,
    { dispatchStartedAt: 2000, turnId: "turn-a", invalidated: false });
  assert.deepEqual(f.operationById("operation-b").evidence,
    { dispatchStartedAt: 3000, boundary: true, invalidated: false });
  assert.equal(f.operationById("operation-a").result?.code, "completed");
  assert.equal(f.operationById("operation-b").result?.code, "completed");
});

test("concurrent reconciles start each operation only once", async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.hook("a", async execution => {
    await execution.checkpoint({ dispatchStartedAt: 1000 });
    await held;
    return { status: "completed", detail: "completed" };
  });
  const worker = f.make();
  const first = worker.reconcile(), second = worker.reconcile();
  // Both reconciles have passed the claim point by the time the run observes.
  await f.until(() => f.operation.state === "observing");
  assert.equal(f.calls.filter(id => id === "a").length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(f.operation.state, "succeeded");
  assert.equal(f.calls.filter(id => id === "a").length, 1);
});

test("restart recovers operations in different phases independently", async () => {
  const f = fixture({ agents: ["a", "b", "c"] });
  const b = f.operationById("operation-b"), c = f.operationById("operation-c");
  b.state = "dispatching";
  b.evidence = { dispatchStartedAt: 1000 };
  c.state = "observing";
  c.evidence = { dispatchStartedAt: 1000 - 180_001 };
  f.evidence = operation => operation.id === "operation-b"
    ? { status: "completed", detail: "matching persisted evidence" } : null;
  f.recover();
  assert.equal(f.operationById("operation-b").state, "observing");
  assert.equal(f.operationById("operation-c").state, "observing");
  await f.make().reconcile();
  assert.equal(f.operationById("operation-a").state, "succeeded");
  assert.equal(f.operationById("operation-b").state, "succeeded");
  assert.equal(f.operationById("operation-c").state, "unknown");
  assert.equal(f.operationById("operation-c").result?.code, "unknown");
  assert.deepEqual(f.calls, ["a"], "only the requested operation was sent");
  assert.equal(f.sends, 1);
});

test("a stopped worker cannot publish late results for any of several operations", async () => {
  const f = fixture({ agents: ["a", "b"] });
  let releaseA!: (outcome: CompactOutcome) => void, releaseB!: (outcome: CompactOutcome) => void;
  f.hook("a", async execution => {
    await execution.checkpoint({ dispatchStartedAt: 1000 });
    f.record("a:checkpointed");
    return new Promise(resolve => { releaseA = resolve; });
  });
  f.hook("b", async execution => {
    await execution.checkpoint({ dispatchStartedAt: 1000 });
    f.record("b:checkpointed");
    return new Promise(resolve => { releaseB = resolve; });
  });
  const first = f.make();
  const running = first.reconcile();
  await f.until(() => f.events.includes("a:checkpointed") && f.events.includes("b:checkpointed"));
  first.stop();
  f.recover();
  f.evidence = () => ({ status: "failed", detail: "native rejection" });
  await f.make().reconcile();
  assert.equal(f.operationById("operation-a").state, "failed");
  assert.equal(f.operationById("operation-b").state, "failed");
  releaseA({ status: "completed", detail: "stale worker" });
  releaseB({ status: "completed", detail: "stale worker" });
  await running;
  assert.equal(f.operationById("operation-a").state, "failed");
  assert.equal(f.operationById("operation-b").state, "failed");
  assert.equal(f.operationById("operation-a").result?.message, "native rejection");
  assert.equal(f.operationById("operation-b").result?.message, "native rejection");
});

test("a confirmed query-restart refusal finishes as failed_after_dispatch after restart without resending", async () => {
  for (const kind of ["manual", "automatic"] as const) {
    const f = fixture();
    const released: string[] = [];
    f.gateway.release = async operation => { released.push(`${operation.id}:${operation.state}`); };
    f.operation.kind = kind;
    f.operation.state = "observing";
    f.operation.evidence = {
      dispatchStartedAt: 1000,
      native: { id: f.operation.id, launchId: "launch", generation: "gen-1", sessionId: "native", revision: 1 },
    };
    f.recover();
    f.evidence = { status: "failed", detail: "Claude query restarted before compaction ran" };
    await f.make().reconcile();
    assert.equal(f.operation.state, "failed", kind);
    assert.equal(f.operation.result?.code, "failed_after_dispatch", kind);
    assert.match(f.operation.result.message, /query restarted/i, kind);
    assert.equal(f.sends, 0, `${kind}: reconciliation must not send again`);
    assert.deepEqual(released, [`${f.operation.id}:failed`], kind);
  }
});

test("a request an earlier instance left prepared is kept only while its operation may still be observed", () => {
  const base: StoredOperation = { id: "op", agentId: "a", revision: "rev", target: { sessionId: "native", activityKey: null },
    kind: "manual", state: "observing", createdAt: 1, updatedAt: 1, result: null, inputFingerprint: null };
  const native = { id: "op", launchId: "launch", generation: "generation", sessionId: "native", revision: 1 };
  const marked = (operation: Partial<StoredOperation>, preparation?: string): StoredOperation => ({ ...base, ...operation,
    evidence: { dispatchStartedAt: 1, native: { ...native, ...(preparation ? { preparation } : {}) } } });
  const unmarked = (operation: Partial<StoredOperation>): StoredOperation => ({ ...base, ...operation,
    evidence: { native: { ...native, preparation: "p" } } });
  const request = (preparation?: string) => ({ id: "op", ...(preparation ? { preparation } : {}) });
  // Possibly sent and still observed: the observer needs the request to attribute its outcome.
  assert.equal(leftoverRetirement(request("p"), marked({ state: "observing" }, "p")), null);
  assert.equal(leftoverRetirement(request(), marked({ state: "observing" })), null,
    "evidence from an earlier release names no preparation, so the request is kept");
  assert.equal(leftoverRetirement(request(), marked({ state: "observing" }, "p")), null,
    "a request from an earlier release names no preparation, so it is matched by its operation");
  // Another preparation of a possibly sent operation is not what it sent against.
  assert.deepEqual(leftoverRetirement(request("q"), marked({ state: "observing" }, "p")), { sent: true });
  // Pending without the marker: the earlier instance never sent it, and a retry prepares anew.
  for (const state of ["requested", "dispatching"] as const)
    assert.deepEqual(leftoverRetirement(request("p"), unmarked({ state })), { sent: false }, state);
  // Finished: retired as the worker's release would, sent once the marker exists.
  for (const state of ["succeeded", "failed", "unknown"] as const)
    assert.deepEqual(leftoverRetirement(request("p"), marked({ state, result: { code: "unknown", message: "m" } }, "p")),
      { sent: true }, state);
  assert.deepEqual(leftoverRetirement(request("p"), unmarked({ state: "expired",
    result: { code: "expired_before_dispatch", message: "m" } })), { sent: false });
  // An operation no longer retained ended at least the retention period ago.
  assert.deepEqual(leftoverRetirement(request("p"), undefined), { sent: false });
});

// Faults a gateway hands to the run that started its work, as a wait that
// already ended or a cleanup step would hand them.
test("a fault an attempt's work met explains the run's fault in place of the deadline that ended its wait", async () => {
  const f = fixture(), worker = f.make();
  const late = new Error("EACCES: request.json");
  f.hook("a", async execution => {
    // The wait on the work ended at its deadline; the work then failed.
    execution.fault(late);
    throw new DeadlineExceeded();
  });
  await worker.reconcile();
  assert.equal(f.operation.state, "requested", "a fault before the marker is retried");
  assert.deepEqual(f.errors, [], "a retried fault is not reported");
  f.advance(200_000);
  await worker.reconcile();
  assert.equal(f.operation.state, "expired");
  assert.deepEqual(f.errors, [late], "the fault that ended the request is the work's own, not the deadline");
  worker.stop();
});

test("a fault an attempt's work hands over while the run classifies its own fault is kept with it", async () => {
  const f = fixture(), worker = f.make();
  let execution: ExecutionContext | undefined;
  f.hook("a", async current => { execution = current; throw new DeadlineExceeded(); });
  // Held as the classification saves the retry.
  const classifying = f.holdCommit(retrying);
  const run = worker.reconcile();
  await classifying.reached;
  const late = new Error("EACCES: request.json");
  assert.ok(execution, "the run handed the gateway its execution");
  execution.fault(late);
  classifying.release();
  await run;
  assert.equal(f.operation.state, "requested", "a fault before the marker is retried");
  assert.deepEqual(f.errors, [], "a retried fault is not reported");
  f.advance(200_000);
  await worker.reconcile();
  assert.equal(f.operation.state, "expired");
  assert.deepEqual(f.errors, [late], "the fault the work met during classification ends the request, not the deadline");
  worker.stop();
});

test("a fault an attempt's work hands over while its expiry is saved still takes the deadline's place", async () => {
  const f = fixture(), worker = f.make();
  let execution: ExecutionContext | undefined;
  f.hook("a", async current => {
    execution = current;
    // The wait ended at the send deadline, so the request expires.
    f.advance(200_000);
    throw new DeadlineExceeded();
  });
  // Held as the expiry's terminal write saves it.
  const expiring = f.holdCommit(expired);
  const run = worker.reconcile();
  await expiring.reached;
  const late = new Error("EACCES: request.json");
  assert.ok(execution, "the run handed the gateway its execution");
  execution.fault(late);
  expiring.release();
  await run;
  assert.equal(f.operation.state, "expired");
  assert.deepEqual(f.errors, [late], "the work's own fault ends the request, reported once");
  worker.stop();
});

test("a stop that interrupts a run's expiry still reports the fault its work met", async () => {
  const f = fixture(), worker = f.make();
  const late = new Error("EACCES: request.json");
  f.hook("a", async execution => {
    execution.fault(late);
    f.advance(200_000);
    throw new DeadlineExceeded();
  });
  const expiring = f.holdCommit(expired);
  const run = worker.reconcile();
  await expiring.reached;
  worker.stop();
  expiring.release();
  await run;
  assert.deepEqual(defects(f.errors), [String(late)], "no later expiry will report it, so the run does");
});

test("the fault that ends a request is still reported when the expiry's first save fails", async () => {
  const f = fixture(), worker = f.make();
  const met = new Error("EACCES: request.json"), disk = new Error("EIO: state file");
  f.hook("a", async () => { f.advance(200_000); throw met; });
  // The expiry's terminal write fails once.
  f.failCommit(disk, expired);
  await worker.reconcile();
  assert.deepEqual(f.errors, [disk], "the failed save is reported");
  await worker.reconcile();
  assert.equal(f.operation.state, "expired");
  assert.deepEqual(f.errors, [disk, met], "the expiry written again reports the fault that ended the request");
  worker.stop();
});

test("a fault an earlier run's work meets after that run ended is reported at once, even while a retry runs", async () => {
  const f = fixture(), worker = f.make();
  let earlier: ExecutionContext | undefined;
  f.hook("a", async execution => { earlier = execution; throw new Error("EBUSY"); });
  await worker.reconcile();
  assert.equal(f.operation.state, "requested");
  const held = gate();
  f.hook("a", async execution => {
    assert.notEqual(execution, earlier, "each run is its own execution");
    await held.pass();
    return { status: "completed", detail: "matching evidence" };
  });
  f.advance(2_000);
  const retry = worker.reconcile();
  await held.reached;
  const late = new Error("EIO: retirement of the earlier preparation");
  assert.ok(earlier, "the first run handed the gateway its execution");
  earlier.fault(late);
  earlier.fault(new Refusal("Claude is still working"));
  assert.deepEqual(f.errors, [late], "the earlier run's fault is its own and is reported; a refusal never is");
  held.release();
  await retry;
  assert.equal(f.operation.state, "succeeded", "the retry's outcome is unchanged");
  assert.deepEqual(f.errors, [late]);
  worker.stop();
});

test("a cleanup failure is reported when it happens, and leaves the run's outcome alone", async () => {
  const f = fixture(), worker = f.make();
  const cleanup = new Error("EIO: subscription release");
  f.hook("a", async execution => {
    execution.cleanupFault(cleanup);
    await execution.checkpoint({ dispatchStartedAt: f.time });
    return { status: "completed", detail: "matching evidence" };
  });
  await worker.reconcile();
  assert.equal(f.operation.state, "succeeded");
  assert.deepEqual(f.errors, [cleanup]);
  worker.stop();
});

test("a fault beside a retried run's own is reported at once, and the run's own if the request expires", async () => {
  const f = fixture(), worker = f.make();
  const thrown = new Error("EBUSY"), beside = new Error("EACCES: request.json");
  f.hook("a", async execution => { execution.fault(beside); throw thrown; });
  await worker.reconcile();
  assert.deepEqual(f.errors, [beside], "it can no longer become the request's cause");
  f.advance(200_000);
  await worker.reconcile();
  assert.equal(f.operation.state, "expired");
  assert.deepEqual(f.errors, [beside, thrown]);
  worker.stop();
});

test("a cleanup failure is reported while its run is still going", async () => {
  const f = fixture(), worker = f.make();
  const cleanup = new Error("EIO: subscription release"), held = gate();
  f.hook("a", async execution => {
    execution.cleanupFault(cleanup);
    await held.pass();
    await execution.checkpoint({ dispatchStartedAt: f.time });
    return { status: "completed", detail: "matching evidence" };
  });
  const run = worker.reconcile();
  await held.reached;
  assert.deepEqual(f.errors, [cleanup], "it never explains the attempt, so nothing waits for the run to end");
  held.release();
  await run;
  assert.deepEqual(f.errors, [cleanup]);
  worker.stop();
});

test("a failure the work meets while the expiry is saved is the cause, whatever an earlier run carried", async () => {
  const f = fixture(), worker = f.make();
  const earlier = new Error("EIO: settings");
  f.hook("a", async () => { throw earlier; });
  await worker.reconcile();
  assert.equal(f.operation.state, "requested", "the earlier run's fault is retried");
  let execution: ExecutionContext | undefined;
  f.hook("a", async current => {
    execution = current;
    // The wait ended at the send deadline, so this run expires the request.
    f.advance(200_000);
    throw new DeadlineExceeded();
  });
  // The retry is due; held as its expiry's terminal write saves it.
  f.advance(2_000);
  const expiring = f.holdCommit(expired);
  const run = worker.reconcile();
  await expiring.reached;
  const late = new Error("EACCES: request.json");
  assert.ok(execution, "the run handed the gateway its execution");
  execution.fault(late);
  expiring.release();
  await run;
  assert.equal(f.operation.state, "expired");
  assert.deepEqual(f.errors, [late], "this run's own failure ends the request, the same as during classification");
  worker.stop();
});

test("a group of failures counts as its separate failures: one is the cause, the others are reported at once", async () => {
  const f = fixture(), worker = f.make();
  const publication = new Error("EACCES: request.json"), removal = new Error("EPERM: request.json.tmp");
  f.hook("a", async () => {
    throw new AggregateError([publication, removal], "Durable replacement failed and its temporary file could not be removed");
  });
  await worker.reconcile();
  assert.equal(f.operation.state, "requested", "the fault is retried");
  assert.deepEqual(f.errors, [removal], "the failure beside the cause is reported at once");
  // The retry's own cause replaces it: only the fault that finally ends the request is reported.
  const deadline = new DeadlineExceeded();
  f.hook("a", async () => { throw deadline; });
  f.advance(2_000);
  await worker.reconcile();
  assert.equal(f.operation.state, "requested");
  worker.stop();
  assert.equal(f.errors.length, 2);
  assert.equal(f.errors[0], removal);
  assert.equal(f.errors[1], deadline, "the stop reports the cause the request carries; the reporter keeps a deadline quiet");
});

test("a cleanup failure of a retried run is reported once, whatever a later retry carries", async () => {
  const f = fixture(), worker = f.make();
  const cleanup = new Error("EACCES: retiring the request"), deadline = new DeadlineExceeded(), busy = new Error("EBUSY");
  f.hook("a", async execution => { execution.cleanupFault(cleanup); throw busy; });
  await worker.reconcile();
  f.hook("a", async () => { throw deadline; });
  f.advance(2_000);
  await worker.reconcile();
  assert.equal(f.operation.state, "requested", "the deadline-only retry is retried again");
  worker.stop();
  assert.equal(f.errors.length, 2);
  assert.equal(f.errors[0], cleanup, "the cleanup failure was reported when it happened");
  assert.equal(f.errors[1], deadline, "the stop reports the cause the request carries; the reporter keeps a deadline quiet");
});

test("a read already issued when the worker stops still has its failure reported", async () => {
  const f = fixture(), worker = f.make();
  let fail!: (error: Error) => void;
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  f.gateway.refresh = () => { reading(); return new Promise<never>((_resolve, reject) => { fail = reject; }); };
  const running = worker.reconcile();
  await started;
  worker.stop();
  await running;
  await worker.idle();
  const defect = new Error("EIO: host read");
  fail(defect);
  await f.until(() => f.errors.includes(defect));
  assert.deepEqual(defects(f.errors), [String(defect)], "besides the stop itself, only the read's own failure is handed on");
  assert.equal(f.sends, 0);
});
