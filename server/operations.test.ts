import assert from "node:assert/strict";
import { test } from "node:test";
import { createOperationWorker, recoverOperations } from "./operations";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import { Refusal, type CompactOutcome, type Gateway, type Observation, type State } from "./model";

function fixture() {
  let time = 1000;
  let state: State = { version: 1, disabled: [], jobs: [], operations: [{
    id: "operation-a", agentId: "a", revision: "rev", target: { sessionId: "native", activityKey: "activity" },
    kind: "manual", state: "requested", createdAt: time, updatedAt: time, result: null,
    inputFingerprint: "fingerprint", sendBy: time + 180_000, attempt: 0,
  }] };
  let sends = 0, writesFail = false;
  const errors: unknown[] = [];
  const agent: Observation = { agentId: "a", revision: "rev", sessionId: "native", activityKey: "activity",
    title: null, workspace: "/work", provider: "claude", tokens: 100, eligible: true, idle: true };
  let evidence: CompactOutcome | null = null;
  const gateway: Gateway = {
    list: async () => [agent], refresh: async () => agent,
    compact: async (_id, _expected, execution) => {
      await execution!.checkpoint({ dispatchStartedAt: time });
      sends++;
      return { status: "completed", detail: "matching evidence" };
    },
    inspect: async () => evidence,
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
    store: { read: async () => structuredClone(state), write: async next => { state = next; } },
    update, settings, now: () => time, onError: error => errors.push(error) });
  return { make, gateway, agent, errors,
    get operation() { return state.operations[0]; },
    get sends() { return sends; },
    set evidence(value: CompactOutcome | null) { evidence = value; },
    set failTerminal(value: boolean) { writesFail = value; },
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
  assert.equal(f.errors.length, 1);
  f.gateway.compact = compact;
  f.advance(2000); await worker.reconcile();
  assert.equal(f.operation.state, "succeeded");
  assert.equal(f.sends, 1);
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
