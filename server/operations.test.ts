import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationWorker, recoverOperations } from "./operations";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import { Refusal, type CompactOutcome, type ExecutionContext, type Gateway, type Observation,
  type State, type StoredOperation } from "./model";

type Evidence = CompactOutcome | null | ((operation: StoredOperation) => CompactOutcome | null);
type Hook = (execution: ExecutionContext | undefined) => Promise<CompactOutcome>;

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
  const gateway: Gateway = {
    list: async () => Object.values(observations), refresh: async id => observations[id] ?? null,
    compact: async (id, _expected, execution) => {
      calls.push(id);
      events.push(`${id}:send`);
      const hook = hooks.get(id);
      if (hook) {
        const outcome = await hook(execution);
        sends++;
        return outcome;
      }
      await execution!.checkpoint({ dispatchStartedAt: time });
      sends++;
      return { status: "completed", detail: "matching evidence" };
    },
    inspect: async operation => typeof evidence === "function" ? evidence(operation) : evidence,
  };
  let tail: Promise<unknown> = Promise.resolve();
  const update = <T>(change: (state: State) => T): Promise<T> => {
    const result = tail.then(() => {
      const next = structuredClone(state);
      const value = change(next);
      if (writesFail && next.operations[0].state === "succeeded") throw new Error("disk full");
      state = next;
      return value;
    });
    tail = result.catch(() => {});
    return result;
  };
  const make = (settings = async (): Promise<Settings | null> => ({ ...DEFAULT_SETTINGS })) => createOperationWorker({ gateway,
    store: { read: async () => {
        if (readsFail > 0) { readsFail--; throw new Error("EBUSY"); }
        if (stale) { const value = stale; stale = null; return structuredClone(value); }
        return structuredClone(state);
      }, write: async next => { state = next; } },
    update, settings, now: () => time, onError: error => errors.push(error) });
  return { make, gateway, errors, calls, events,
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
    advance(ms: number) { time += ms; },
    recover() { recoverOperations(state, time); },
  };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 500 && !condition(); i++)
    await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(condition(), "expected the condition within the test's bounded wait");
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
    await execution!.checkpoint({ dispatchStartedAt: 1000 });
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
  assert.ok(f.operation.attempt! > 3, "the send deadline, not a count, bounds the retries");
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

test("the worker wakes itself for a retry instead of waiting for the next tick", async () => {
  const f = fixture(), worker = f.make();
  const compact = f.gateway.compact;
  f.gateway.compact = async () => { throw new Error("observer preparation timed out"); };
  await worker.reconcile();
  assert.equal(f.operation.state, "requested");
  f.gateway.compact = compact;
  f.advance(2000);
  const state = () => f.operation.state;
  for (let i = 0; i < 40 && state() !== "succeeded"; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(state(), "succeeded");
  worker.stop();
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
    assert.match(f.operation.result!.message, new RegExp(reason), reason);
    assert.equal(f.operation.evidence?.dispatchStartedAt, undefined, reason);
    assert.equal(f.errors.length, 0, "a refusal is not reported as a fault");
  }
});

test("a failure after the dispatch marker is recorded as sent", async () => {
  const f = fixture(), worker = f.make();
  f.gateway.compact = async (_id, _expected, execution) => {
    await execution!.checkpoint({ dispatchStartedAt: 1000 });
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
  f.gateway.compact = async (_id, _expected, execution) => {
    await execution!.checkpoint({ dispatchStartedAt: 1000 });
    return new Promise(resolve => { release = resolve; });
  };
  const running = first.reconcile();
  while (!release) await new Promise<void>(resolve => setImmediate(resolve));
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
    await execution!.checkpoint({ dispatchStartedAt: 10_000 });
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
    await execution!.checkpoint({ dispatchStartedAt: 1000 });
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
    await execution!.checkpoint({ dispatchStartedAt: 101_000 });
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
    await execution!.checkpoint({ dispatchStartedAt: 1000 });
    f.events.push("a:marker");
    await heldA;
    f.events.push("a:release");
    return { status: "completed", detail: "A completed" };
  });
  const running = f.make().reconcile();
  try {
    await until(() => f.operationById("operation-b").state === "succeeded");
    assert.equal(f.operationById("operation-a").state, "observing");
    assert.equal(f.sends, 1, "only B has completed its send while A is held");
    assert.ok(f.events.includes("b:send"), "B is sent while A is still held");
    assert.ok(!f.events.includes("a:release"), "A has not been released yet");
  } finally {
    releaseA();
    await running;
  }
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
    await execution!.checkpoint({ dispatchStartedAt: 1000 });
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
    await execution!.checkpoint({ dispatchStartedAt: 2000, turnId: "turn-a" });
    f.events.push("a:checkpointed");
    await gateA;
    return { status: "completed", detail: "A completed" };
  });
  f.hook("b", async execution => {
    await execution!.checkpoint({ dispatchStartedAt: 3000, boundary: true });
    f.events.push("b:checkpointed");
    await gateB;
    return { status: "completed", detail: "B completed" };
  });
  const running = f.make().reconcile();
  try {
    await until(() => f.events.includes("a:checkpointed") && f.events.includes("b:checkpointed"));
    assert.equal(f.operationById("operation-a").state, "observing");
    assert.equal(f.operationById("operation-b").state, "observing");
    releaseA();
    await until(() => f.operationById("operation-a").state === "succeeded");
    assert.equal(f.operationById("operation-b").state, "observing", "B is still held");
  } finally {
    releaseA(); releaseB();
    await running;
  }
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
    await execution!.checkpoint({ dispatchStartedAt: 1000 });
    await held;
    return { status: "completed", detail: "completed" };
  });
  const worker = f.make();
  const first = worker.reconcile(), second = worker.reconcile();
  try {
    // Both reconciles have passed the claim point by the time the run observes.
    await until(() => f.operation.state === "observing");
    assert.equal(f.calls.filter(id => id === "a").length, 1);
  } finally {
    release();
    await Promise.all([first, second]);
  }
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
    await execution!.checkpoint({ dispatchStartedAt: 1000 });
    f.events.push("a:checkpointed");
    return new Promise(resolve => { releaseA = resolve; });
  });
  f.hook("b", async execution => {
    await execution!.checkpoint({ dispatchStartedAt: 1000 });
    f.events.push("b:checkpointed");
    return new Promise(resolve => { releaseB = resolve; });
  });
  const first = f.make();
  const running = first.reconcile();
  await until(() => f.events.includes("a:checkpointed") && f.events.includes("b:checkpointed"));
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
