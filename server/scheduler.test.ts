import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  type Settings,
} from "../shared/settings";
import { createScheduler, FULL_SCAN_INTERVAL_MS, TICK_INTERVAL_MS } from "./scheduler";
import { DeadlineExceeded, INSPECT_TIMEOUT_MS, Stopped, type Timers } from "./deadline";
import { DELIVERY_WINDOW_MS } from "./policy";
import { HISTORY_RETENTION_MS, HISTORY_SWEEP_INTERVAL_MS, type OperationReceipts } from "./retention";
import { changes } from "../tests/support/changes";
import { fakeTimers, undefinedHandleTimers } from "../tests/support/timers";
import { drainer } from "../tests/support/drained";
import { defects } from "../tests/support/defects";
import { gate, type Gate } from "../tests/support/gate";
import { cleanupScope } from "../tests/support/scope";
import type { Blocked } from "../shared/rpc";
import { Refusal, type DispatchGuard, type ExecutionContext, type Gateway, type Observation, type State,
  type StateStore } from "./model";

function fixture(automatic = true) {
  let time = 1_000_000;
  let config: Settings | null = { ...DEFAULT_SETTINGS };
  let state: State = { version: 1, disabled: [], jobs: [], operations: [] };
  let calls = 0;
  const sent: string[] = [];
  const compactHolds = new Map<string, () => Promise<void>>();
  const refreshHolds = new Map<string, () => Promise<void>>();
  const listedHolds = new Map<string, () => Promise<void>>();
  // A held settings read, `skip` reads from when it was set.
  let settingsHold: { skip: number; hold: () => Promise<void> } | null = null;
  // A held state read: the first to start once `when` holds; it reads once released.
  let readHold: { when: () => boolean; held: Gate } | null = null;
  // The next state write, held once it has started; it lands once released.
  let writeHold: { held: Gate; carries?: State } | null = null;
  const errors: unknown[] = [];
  // Receipt removals and sweeps as they start, and the one held until released.
  const receiptCalls: string[] = [];
  const receiptHolds = new Map<string, Gate>();
  // Resource use the optimization promises to bound.
  const counts = {
    reads: 0, writes: 0, lists: 0, settings: 0, settingsEnded: 0, readiness: 0, refreshes: [] as string[],
    reset() {
      this.reads = 0; this.writes = 0; this.lists = 0; this.settings = 0; this.settingsEnded = 0;
      this.readiness = 0; this.refreshes = [];
    },
  };
  let listGate: Promise<void> | null = null;
  // Listings waiting at the gate `holdList` set, and listings running now and
  // at most at once, counted from each call's start to its return.
  let heldLists = 0, activeLists = 0, peakLists = 0;
  // Host reads and listed observations as they start and end, in order, so a
  // test checks from whole calls what ran while another still did.
  const hostCalls: string[] = [];
  // Resolves once nothing is left to run but what the test holds.
  const drained = drainer();
  // Stored states, sends, reads and armed timers wake tests waiting for them.
  const signal = changes();
  // The scheduler's and its worker's timers run only when a test moves them on.
  const timers = fakeTimers(signal.changed);
  const agents: Observation[] = [
    {
      agentId: "a",
      title: "Session",
      workspace: "/work",
      provider: "claude",
      revision: new Date(time).toISOString(),
      tokens: 210_000,
      eligible: true,
      idle: true,
      sessionId: "native-a",
    },
  ];
  const store: StateStore = {
    read: async () => {
      counts.reads++;
      const hold = readHold;
      if (hold?.when()) { readHold = null; await hold.held.pass(); }
      return structuredClone(state);
    },
    write: async (next) => {
      counts.writes++;
      const hold = writeHold;
      if (hold) { writeHold = null; hold.carries = structuredClone(next); await hold.held.pass(); }
      state = structuredClone(next);
      signal.changed();
    },
  };
  const compact: Gateway["compact"] = async (agentId) => {
    calls++;
    sent.push(agentId);
    signal.changed();
    await compactHolds.get(agentId)?.();
    return { status: "completed", detail: "same session, completed boundary" };
  };
  const refresh: Gateway["refresh"] = async (id) => {
    counts.refreshes.push(id);
    hostCalls.push(`read ${id}`);
    signal.changed();
    try {
      await refreshHolds.get(id)?.();
      return structuredClone(agents.find((a) => a.agentId === id) ?? null);
    } finally {
      hostCalls.push(`read ${id} ended`);
    }
  };
  const gateway: Gateway = {
    list: async (observe) => {
      counts.lists++;
      peakLists = Math.max(peakLists, ++activeLists);
      try {
        const listed = structuredClone(agents);
        if (listGate) {
          heldLists++;
          signal.changed();
          await listGate;
          heldLists--;
        }
        for (const agent of listed) {
          hostCalls.push(`listed ${agent.agentId}`);
          observe((async () => {
            try {
              await listedHolds.get(agent.agentId)?.();
              return agent;
            } finally {
              hostCalls.push(`listed ${agent.agentId} ended`);
            }
          })());
        }
      } finally {
        activeLists--;
      }
    },
    refresh,
    compact,
    ...(automatic ? { automatic: async (expected: Observation, _guard: DispatchGuard | undefined, execution: ExecutionContext) =>
      compact(expected.agentId, expected, execution) } : {}),
  };
  // Passed to the scheduler only by a test that asks for history cleanup.
  const receipts: OperationReceipts = {
    remove: async (_agentId, operationId) => {
      receiptCalls.push(`remove ${operationId}`);
      signal.changed();
      await receiptHolds.get("remove")?.pass();
    },
    sweep: async () => {
      receiptCalls.push("sweep");
      signal.changed();
      await receiptHolds.get("sweep")?.pass();
    },
  };
  const make = (options: { receipts?: boolean; timers?: Timers } = {}) =>
    createScheduler({
      store,
      onError: error => errors.push(error),
      ...options.receipts ? { receipts } : {},
      gateway,
      settings: async () => {
        counts.settings++;
        const held = settingsHold;
        try {
          if (held && held.skip-- === 0) { settingsHold = null; await held.hold(); }
          return config;
        } finally {
          counts.settingsEnded++;
        }
      },
      now: () => time,
      timers: options.timers ?? timers,
    });
  const addAgent = (id = "b") => {
    const agent = { ...agents[0], agentId: id, title: `Session ${id}`, sessionId: `native-${id}` };
    agents.push(agent);
    return agent;
  };
  return {
    agents,
    gateway,
    store,
    make,
    addAgent,
    holdCompact(agentId: string, hold: () => Promise<void>) {
      compactHolds.set(agentId, hold);
    },
    holdRefresh(agentId: string, hold: () => Promise<void>) {
      refreshHolds.set(agentId, hold);
    },
    holdSettings(skip: number, hold: () => Promise<void>) {
      settingsHold = { skip, hold };
    },
    // Holds the first state read that starts once `when` holds, before it reads.
    holdRead(when = () => true): Gate {
      const held = gate();
      readHold = { when, held };
      return held;
    },
    // Answers readiness checks with `check`, counting each one as it starts.
    readiness(check: NonNullable<Gateway["readiness"]>) {
      gateway.readiness = async (...args) => { counts.readiness++; return check(...args); };
    },
    // Holds the next state write once it has started; `carries` is the state it
    // lands once released.
    holdWrite() {
      const hold: { held: Gate; carries?: State } = { held: gate() };
      writeHold = hold;
      return { ...hold.held, carries: () => hold.carries };
    },
    // Holds the next receipt removal or sweep once it has started.
    holdReceipts(kind: "remove" | "sweep"): Gate {
      const held = gate();
      receiptHolds.set(kind, held);
      return held;
    },
    receiptCalls,
    errors,
    // Hold one listed conversation's observation, not the listing itself.
    holdListed(agentId: string, hold: () => Promise<void>) {
      listedHolds.set(agentId, hold);
    },
    counts,
    // Waits until the condition holds after a stored state, send or read.
    until: signal.until,
    timers,
    // Resolves once a listing waits at the gate `holdList` set.
    listingHeld: () => signal.until(() => heldLists > 0),
    // The most listings that ran at once.
    get peakLists() { return peakLists; },
    hostCalls,
    drained,
    // Hold agent listings (not refreshes) until released.
    holdList() {
      let release!: () => void;
      listGate = new Promise<void>((resolve) => { release = resolve; });
      return () => { listGate = null; release(); };
    },
    get config() {
      return config;
    },
    set config(value: Settings | null) {
      config = value;
    },
    get state() {
      return state;
    },
    get calls() {
      return calls;
    },
    get sent() {
      return sent;
    },
    get time() {
      return time;
    },
    advance(ms: number) {
      time += ms;
    },
  };
}


async function waitForStatus(f: ReturnType<typeof fixture>, status: State["jobs"][number]["status"]) {
  const agentId = f.state.jobs[0]?.agentId;
  assert.ok(agentId, "expected a job to wait for");
  await waitForAgentStatus(f, agentId, status);
}

function waitForAgentStatus(f: ReturnType<typeof fixture>, agentId: string,
  status: State["jobs"][number]["status"]) {
  return f.until(() => f.state.jobs.find((job) => job.agentId === agentId)?.status === status);
}


test("defaults remain 200,000 tokens and 55 minutes; invalid settings rejected", () => {
  assert.equal(DEFAULT_SETTINGS.threshold, 200_000);
  assert.equal(DEFAULT_SETTINGS.idleMinutes, 55);
  assert.equal(SettingsSchema.safeParse({ threshold: 0 }).success, false);
  assert.equal(SettingsSchema.safeParse({ idleMinutes: 1.5 }).success, false);
});

test("55-minute delay, one execution per ordinary revision, even if summary stays large", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000 - 1);
  await s.tick();
  assert.equal(f.calls, 0);
  f.advance(1);
  await s.tick();
  assert.equal(f.calls, 1);
  await s.observedTurn(f.agents[0]);
  await s.tick();
  assert.equal(f.calls, 1);
  assert.equal(f.state.jobs[0].status, "completed");
});

test("stock host blocks automatic dispatch while preserving manual access", async () => {
  const f = fixture(false);
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 0);
  assert.equal((await s.list())[0].status, "blocked");
  assert.equal(
    (await s.compactNow("a", f.agents[0].revision!)).status,
    "running"
  );
  await waitForStatus(f, "completed");
});

test("threshold filtering and unknown context are distinct", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  f.agents[0].tokens = 199_999;
  assert.equal((await s.list()).length, 0);
  f.agents[0].tokens = null;
  const row = (await s.list())[0];
  assert.equal(row.tokens, null);
  assert.equal(row.status, "blocked");
  assert.equal(
    (await s.compactNow("a", f.agents[0].revision!)).status,
    "running"
  );
  await waitForStatus(f, "completed");
  assert.equal(f.calls, 1);
});

test("manual compact ignores automatic context thresholds while automatic dispatch still requires known sufficient usage", async () => {
  for (const tokens of [0, 100, 330_876, null]) {
    const f = fixture();
    f.config = { ...f.config!, threshold: 400_000 };
    f.agents[0].tokens = tokens;
    const s = f.make();
    await s.ready;
    await s.observedTurn(f.agents[0]);
    f.advance(55 * 60_000);
    await s.tick();
    assert.equal(f.calls, 0, `automatic dispatch must not run with ${tokens} tokens`);
    assert.equal((await s.compactNow("a", f.agents[0].revision!)).status, "running");
    await waitForStatus(f, "completed");
    assert.equal(f.calls, 1);
  }
});

test("session off survives disappearing rows and scheduler restart", async () => {
  const f = fixture();
  let s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  await s.toggle("a", false);
  f.agents[0].tokens = 100;
  assert.equal((await s.list()).length, 0);
  s = f.make();
  await s.ready;
  f.agents[0].tokens = 210_000;
  assert.equal((await s.list())[0].enabled, false);
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 0);
  await s.toggle("a", true);
  await s.tick();
  assert.equal(f.calls, 1);
});

test("conversation controls include small and unknown sessions but exclude ineligible sessions", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  f.agents[0].tokens = 100;
  assert.equal((await s.list()).length, 0);
  assert.equal((await s.session("a"))?.tokens, 100);
  await s.toggle("a", false);
  assert.equal((await s.session("a"))?.enabled, false);
  f.agents[0].tokens = null;
  assert.equal((await s.session("a"))?.tokens, null);
  f.agents[0].eligible = false;
  assert.equal(await s.session("a"), null);
  assert.equal(await s.session("missing"), null);
  assert.equal(f.calls, 0);
});

test("global and provider settings are rechecked before dispatch", async () => {
  for (const change of [
    { enabled: false },
    { disabledProviders: ["claude"] },
    { threshold: 300_000 },
  ]) {
    const f = fixture();
    const s = f.make();
    await s.ready;
    await s.observedTurn(f.agents[0]);
    f.config = { ...DEFAULT_SETTINGS, ...change };
    f.advance(55 * 60_000);
    await s.tick();
    assert.equal(f.calls, 0);
  }
});

test("delay edits recalculate reservations from observed turn end", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.config = { ...DEFAULT_SETTINGS, idleMinutes: 10 };
  assert.equal((await s.list())[0].dueAt, f.time + 10 * 60_000);
  f.advance(10 * 60_000);
  await s.tick();
  assert.equal(f.calls, 1);
});

test("skip only this revision; new activity can schedule again", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  assert.equal(await s.skip("a", "stale"), false);
  assert.equal(await s.skip("a", f.agents[0].revision!), true);
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 0);
  f.agents[0].revision = new Date(f.time).toISOString();
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 1);
  assert.equal((await s.list())[0].enabled, true);
});

test("undo skip preserves the original time and executes only at that time", async () => {
  const f = fixture(), s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  const original = (await s.session("a"))!.dueAt!;
  f.advance(5 * 60_000);
  await s.skip("a", f.agents[0].revision!);
  const skipped = (await s.session("a"))!;
  assert.equal(skipped.dueAt, null);
  assert.equal(skipped.undoSkip?.dueAt, original);
  assert.equal(skipped.enabled, true);
  assert.equal(await s.undoSkip("a", skipped.revision!, skipped.undoSkip.id), true);
  assert.equal((await s.session("a"))!.dueAt, original);
  assert.equal((await s.session("a"))!.undoSkip, null);
  assert.equal(f.calls, 0);
  f.advance(original - f.time - 1);
  await s.tick();
  assert.equal(f.calls, 0);
  f.advance(1);
  await s.tick();
  assert.equal(f.calls, 1);
});

test("an old undo request cannot undo a later skip of the same reservation", async () => {
  const f = fixture(), s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  const revision = f.agents[0].revision!;
  await s.skip("a", revision);
  const first = (await s.session("a"))!.undoSkip!.id;
  assert.equal(await s.undoSkip("a", revision, first), true);
  await s.skip("a", revision);
  const second = (await s.session("a"))!.undoSkip!.id;
  assert.notEqual(second, first);
  assert.equal(await s.undoSkip("a", revision, first), false);
  assert.equal((await s.session("a"))!.status, "skipped");
  assert.equal(await s.undoSkip("a", revision, second), true);
  assert.equal(await s.undoSkip("a", revision, second), false);
  assert.equal(f.calls, 0);
});

test("expired, changed, busy, and attempted reservations cannot be unskipped", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.advance(55 * 60_000),
    (f: ReturnType<typeof fixture>) => { f.agents[0].revision = "new-revision"; },
    (f: ReturnType<typeof fixture>) => { f.agents[0].sessionId = "other-session"; },
    (f: ReturnType<typeof fixture>) => { f.agents[0].idle = false; },
    (f: ReturnType<typeof fixture>) => { f.agents[0].eligible = false; },
    (f: ReturnType<typeof fixture>) => { f.agents.splice(0); },
    (f: ReturnType<typeof fixture>) => { f.config!.idleMinutes = 60; },
    (f: ReturnType<typeof fixture>) => { f.config = null; },
    (f: ReturnType<typeof fixture>) => { f.state.jobs[0].attemptedAt = f.time; },
  ]) {
    const f = fixture(), s = f.make();
    await s.ready;
    await s.observedTurn(f.agents[0]);
    const revision = f.agents[0].revision!;
    await s.skip("a", revision);
    const id = (await s.session("a"))!.undoSkip!.id;
    change(f);
    assert.equal(await s.undoSkip("a", revision, id), false);
    assert.equal((await s.session("a"))?.undoSkip ?? null, null);
    assert.equal(f.state.jobs[0].status, "skipped");
    assert.equal(f.calls, 0);
  }
});

test("permission/activity invalidation permanently removes undo even without a new revision", async () => {
  const f = fixture(), s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  await s.skip("a", f.agents[0].revision!);
  const id = (await s.session("a"))!.undoSkip!.id;
  await s.invalidate("a");
  assert.equal((await s.session("a"))!.undoSkip, null);
  assert.equal(await s.undoSkip("a", f.agents[0].revision!, id), false);
  assert.equal(f.state.jobs[0].detail, "Activity or session state changed");
});

test("undo persists across reload and never re-enables global, provider, or conversation policies", async () => {
  const f = fixture();
  let s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  await s.skip("a", f.agents[0].revision!);
  const id = (await s.session("a"))!.undoSkip!.id;
  s.stop();
  s = f.make();
  await s.ready;
  assert.equal((await s.session("a"))!.undoSkip!.id, id);
  await s.toggle("a", false);
  f.config!.enabled = false;
  f.config!.disabledProviders = ["claude"];
  assert.equal(await s.undoSkip("a", f.agents[0].revision!, id), true);
  assert.deepEqual(f.state.disabled, ["a"]);
  assert.equal(f.config!.enabled, false);
  assert.deepEqual(f.config!.disabledProviders, ["claude"]);
  assert.equal((await s.session("a"))!.status, "disabled");
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 0);
});

test("automatic cancellation and old skips without undo metadata are not restorable", async () => {
  const f = fixture(), s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  await s.invalidate("a");
  assert.equal((await s.session("a"))!.undoSkip, null);
  assert.equal(await s.undoSkip("a", f.agents[0].revision!, "invented"), false);
  f.state.jobs[0].detail = "This reservation skipped; session policy unchanged";
  assert.equal((await s.session("a"))!.undoSkip, null);
  assert.equal(await s.undoSkip("a", f.agents[0].revision!, "invented"), false);
});

test("new prompt, permission/busy state, archive, missing session, and reduced context cancel dispatch", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.agents[0].revision = new Date(f.time).toISOString();
    },
    (f: ReturnType<typeof fixture>) => {
      f.agents[0].idle = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.agents[0].eligible = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.agents.splice(0);
    },
    (f: ReturnType<typeof fixture>) => {
      f.agents[0].tokens = 100;
    },
  ]) {
    const f = fixture();
    const s = f.make();
    await s.ready;
    await s.observedTurn(f.agents[0]);
    f.advance(55 * 60_000);
    change(f);
    await s.tick();
    assert.equal(f.calls, 0);
    assert.equal(f.state.jobs[0].status, "skipped");
  }
});

test("activity hook invalidates old reservation before due time", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  await s.invalidate("a");
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 0);
});

test("cancelled reservations lose their displayed time and a new turn gets a new time", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  assert.equal((await s.list())[0].dueAt, f.time + 55 * 60_000);
  await s.invalidate("a");
  const cancelled = (await s.list())[0];
  assert.equal(cancelled.status, "skipped");
  assert.equal(cancelled.enabled, true);
  assert.equal(cancelled.dueAt, null);
  // A busy overlay must not bring the cancelled time back.
  f.agents[0].idle = false;
  assert.equal((await s.list())[0].dueAt, null);
  f.agents[0].idle = true;
  f.advance(60_000);
  f.agents[0].revision = new Date(f.time).toISOString();
  await s.observedTurn(f.agents[0]);
  const next = (await s.list())[0];
  assert.equal(next.status, "scheduled");
  assert.equal(next.dueAt, f.time + 55 * 60_000);
});

test("expired and finished reservations have no displayed time", async () => {
  for (const status of [
    "expired",
    "skipped",
    "completed",
    "failed",
    "unknown",
    "running",
  ] as const) {
    const f = fixture();
    const s = f.make();
    await s.ready;
    await s.observedTurn(f.agents[0]);
    await f.store.write({
      ...f.state,
      jobs: [{ ...f.state.jobs[0], status }],
    });
    assert.equal((await s.list())[0].dueAt, null, status);
  }
});

test("late end event cannot schedule a newer still-running revision", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  f.agents[0].idle = false;
  await s.observedTurn(f.agents[0]);
  assert.equal(f.state.jobs.length, 0);
  f.agents[0].idle = true;
  f.agents[0].revision = new Date(f.time + 1).toISOString();
  await s.observedTurn(f.agents[0]);
  assert.equal(f.state.jobs.length, 0);
});

test("sleep past delivery window expires instead of replaying", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000 + DELIVERY_WINDOW_MS + 1);
  await s.tick();
  assert.equal(f.calls, 0);
  assert.equal(f.state.jobs[0].status, "expired");
});

test("restart preserves future schedules but expires already-due ones", async () => {
  const f = fixture();
  let s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(60_000);
  s = f.make();
  await s.ready;
  assert.equal(f.state.jobs[0].status, "scheduled");
  f.advance(54 * 60_000);
  s = f.make();
  await s.ready;
  await s.tick();
  assert.equal(f.calls, 0);
  assert.equal(f.state.jobs[0].status, "expired");
});

test("ambiguous in-flight restart and failed compact never retry automatically", async () => {
  const f = fixture();
  let s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  // Sent, then the plugin restarts before any evidence arrives.
  let sends = 0;
  f.gateway.automatic = async (_agent, _guard, execution) => {
    sends++;
    await execution.checkpoint({ dispatchStartedAt: f.time });
    return new Promise(() => {});
  };
  f.advance(55 * 60_000);
  void s.tick();
  await f.until(() => f.state.operations[0]?.evidence?.dispatchStartedAt !== undefined);
  s.stop();
  s = f.make();
  await s.ready;
  assert.equal(f.state.operations[0].state, "observing");
  f.advance(180_001);
  await s.tick();
  assert.equal(f.state.jobs[0].status, "unknown");
  await s.tick();
  assert.equal(sends, 1);
  assert.equal(f.calls, 0);
  assert.equal(
    (await s.compactNow("a", f.agents[0].revision!)).status,
    "unknown"
  );
});

test("RPC acceptance or error cannot be promoted to completion by scheduler", async () => {
  for (const status of ["unknown", "failed"] as const) {
    const f = fixture();
    f.gateway.automatic = async () => ({
      status,
      detail: "No completed boundary",
    });
    const s = f.make();
    await s.ready;
    await s.observedTurn(f.agents[0]);
    f.advance(55 * 60_000);
    await s.tick();
    await s.tick();
    assert.equal(f.state.jobs[0].status, status);
  }
});

test("list and policy edits remain responsive during a compaction; another conversation compacts independently", async () => {
  const f = fixture();
  f.addAgent("b");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.holdCompact("a", async () => {
    started();
    await gate;
  });
  const s = f.make();
  await s.ready;
  const run = s.compactNow("a", f.agents[0].revision!);
  await start;
  try {
    assert.equal((await s.list())[0].status, "running");
    await s.toggle("b", false);
    const b = await s.compactNow("b", f.agents[1].revision!);
    assert.equal(b.code, "accepted");
    assert.equal(b.status, "running");
    await waitForAgentStatus(f, "b", "completed");
    assert.deepEqual(f.sent, ["a", "b"], "b is sent while a is still held");
    assert.equal(f.state.jobs.find((job) => job.agentId === "a")?.status, "running");
  } finally {
    release();
  }
  await run;
  await waitForAgentStatus(f, "a", "completed");
  assert.deepEqual(f.state.disabled, ["b"]);
});

test("a refused compaction does not affect another conversation's Compact now", async () => {
  const f = fixture();
  f.addAgent("b");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdCompact("a", async () => {
    started();
    await gate;
    throw new Refusal("Claude is still working");
  });
  const s = f.make();
  await s.ready;
  const run = s.compactNow("a", f.agents[0].revision!);
  await start;
  try {
    const b = await s.compactNow("b", f.agents[1].revision!);
    assert.equal(b.code, "accepted");
    await waitForAgentStatus(f, "b", "completed");
    assert.deepEqual(f.sent, ["a", "b"], "b is sent while a is still held");
  } finally {
    release();
  }
  await run;
  await waitForAgentStatus(f, "a", "failed");
  assert.equal(
    f.state.operations.find((operation) => operation.agentId === "a")?.result?.code,
    "failed_before_dispatch"
  );
  assert.equal(f.state.jobs.find((job) => job.agentId === "b")?.status, "completed");
});

test("a second Compact now while a conversation is pending returns that operation", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdCompact("a", async () => { started(); await gate; });
  const s = f.make();
  await s.ready;
  const revision = f.agents[0].revision!;
  await s.compactNow("a", revision, "request-a");
  await start;
  try {
    const second = await s.compactNow("a", revision, "request-b");
    assert.equal(second.code, "existing");
    assert.equal(second.operationId, "request-a");
    assert.equal(second.status, "running");
    assert.deepEqual(f.sent, ["a"]);
  } finally {
    release();
  }
  await waitForAgentStatus(f, "a", "completed");
});

test("an earlier intake cannot use a stale read after a newer request is saved", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let held = false;
  f.holdRefresh("a", async () => {
    if (held) return;
    held = true;
    started();
    await gate;
  });
  const s = f.make();
  await s.ready;
  const revision = f.agents[0].revision!;
  const first = s.compactNow("a", revision, "request-a");
  await start;
  const secondRequest = s.compactNow("a", revision, "request-b");
  const secondResult = await secondRequest;
  release();
  const firstResult = await first;
  assert.equal(secondResult.code, "accepted");
  assert.equal(firstResult.code, "existing");
  assert.equal(firstResult.operationId, "request-b");
  assert.equal(f.state.operations.length, 1);
  await waitForStatus(f, "completed"); // the accepted request is sent after it answers
  assert.deepEqual(f.sent, ["a"]);
});

test("concurrent duplicate submissions return one operation and send once", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let held = false;
  f.holdRefresh("a", async () => {
    if (held) return;
    held = true;
    started();
    await gate;
  });
  const s = f.make();
  await s.ready;
  const revision = f.agents[0].revision!;
  const first = s.compactNow("a", revision, "request-a");
  await start;
  const secondRequest = s.compactNow("a", revision, "request-a");
  const secondResult = await secondRequest;
  release();
  const firstResult = await first;
  assert.equal(secondResult.code, "accepted");
  assert.equal(firstResult.code, "existing");
  assert.equal(firstResult.operationId, secondResult.operationId);
  assert.equal(f.state.operations.length, 1);
  await waitForStatus(f, "completed"); // the accepted request is sent after it answers
  assert.deepEqual(f.sent, ["a"]);
});

test("a live read taken during intake decides the request, not an earlier snapshot", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdRefresh("a", async () => { started(); await gate; });
  const s = f.make();
  await s.ready;
  const request = s.compactNow("a", f.agents[0].revision!, "request-a");
  await start;
  f.agents[0].revision = new Date(f.time + 1_000).toISOString();
  release();
  const result = await request;
  assert.equal(result.code, "blocked");
  assert.match(result.detail, /conversation changed/);
  assert.equal(f.state.operations.length, 0);
  assert.deepEqual(f.sent, []);
});

test("a slow host read for one conversation does not hold up other conversations", async () => {
  const f = fixture();
  f.addAgent("b");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdRefresh("a", async () => { started(); await gate; });
  const s = f.make();
  await s.ready;
  const pending = s.compactNow("a", f.agents[0].revision!);
  await start;
  const work = Promise.all([
    s.session("b"),
    s.toggle("b", false),
    s.operation("missing"),
    s.compactNow("b", f.agents[1].revision!),
  ]);
  // Resolves while a's host read is held.
  const [session, changed, missing, compact] = await work;
  release();
  assert.equal(session?.agentId, "b");
  assert.equal(changed, true);
  assert.equal(missing, null);
  assert.equal(compact.code, "accepted");
  await waitForAgentStatus(f, "b", "completed");
  assert.equal(f.sent.filter((agentId) => agentId === "b").length, 1);
  await pending;
});

test("the periodic pass runs every ten seconds and the full scan once a minute", () => {
  assert.equal(TICK_INTERVAL_MS, 10_000);
  assert.equal(FULL_SCAN_INTERVAL_MS, 60_000);
});

test("Compact now acknowledges a slow backend before the plugin RPC deadline", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.gateway.compact = async () => {
    await gate;
    return { status: "completed", detail: "Completed boundary" };
  };
  const scheduler = f.make();
  await scheduler.ready;

  // The backend stays held until the request has answered.
  const first = await scheduler.compactNow("a", f.agents[0].revision!);
  release();
  await waitForStatus(f, "completed");

  assert.equal(first.status, "running");
  assert(first.operationId);
  assert.match(first.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(f.state.jobs[0].operationId, first.operationId);
});

test("unreadable settings and stopped plugin never send", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.config = null;
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 0);
  f.config = { ...DEFAULT_SETTINGS };
  s.stop();
  await assert.rejects(s.tick(), Stopped);
  assert.equal(f.calls, 0);
});

test("stopping the plugin while its worker reads the settings before sending leaves no wait armed", async (t) => {
  const f = fixture();
  const s = f.make();
  cleanupScope(t).defer(() => s.stop());
  await s.ready;
  let reached!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  // Compact now reads the settings once before it saves the request; the worker's read is the next.
  f.holdSettings(1, async () => { reached(); await released; });
  assert.equal((await s.compactNow("a", f.agents[0].revision!, "request-a")).code, "accepted");
  await reading;
  s.stop();
  assert.equal(f.timers.pending, 0, "the worker's read and any bound around it end with the plugin");
  release();
  await s.idle();
  assert.equal(f.calls, 0);
  assert.equal(f.timers.pending, 0);
});

test("a known short TTL or expired cache prevents automatic dispatch", async () => {
  const f = fixture();
  let blocked: Blocked | null = { reason: "idle_delay_exceeds_cache",
    detail: "Idle delay exceeds the 5-minute cache window (transcript)" };
  f.gateway.readiness = async () => blocked;
  const scheduler = f.make();
  await scheduler.ready;
  await scheduler.observedTurn(f.agents[0]);
  f.advance(55 * 60000);
  await scheduler.tick();
  assert.equal(f.calls, 0);
  assert.equal(f.state.jobs[0].attemptedAt, undefined);
  assert.equal((await scheduler.list())[0].detail, blocked.detail);
  blocked = null;
  await scheduler.tick();
  assert.equal(f.calls, 1);
  assert.equal(f.state.jobs[0].status, "completed");
});

test("disconnected startup timers expire elapsed reservations without obtaining or using a host API", async () => {
  const f = fixture();
  const scheduler = f.make();
  await scheduler.ready;
  await scheduler.observedTurn(f.agents[0]);
  f.gateway.refresh = async () => {
    throw new Error("Host API must not be called");
  };
  f.advance(55 * 60000);
  await scheduler.tick(false);
  assert.equal(f.state.jobs[0].status, "scheduled");
  assert.equal(f.calls, 0);
  f.advance(DELIVERY_WINDOW_MS + 1);
  await scheduler.tick(false);
  assert.equal(f.state.jobs[0].status, "expired");
  assert.equal(f.calls, 0);
});

test("policy changes during asynchronous observation prevent an automatic reservation", async () => {
  for (const config of [
    null,
    { ...DEFAULT_SETTINGS, enabled: false },
    { ...DEFAULT_SETTINGS, threshold: 999999 },
    { ...DEFAULT_SETTINGS, idleMinutes: 56 },
    { ...DEFAULT_SETTINGS, disabledProviders: ["claude"] },
  ]) {
    const f = fixture();
    f.gateway.readiness = async () => {
      f.config = config;
      return null;
    };
    const scheduler = f.make();
    await scheduler.ready;
    await scheduler.observedTurn(f.agents[0]);
    f.advance(55 * 60000);
    await scheduler.tick();
    assert.equal(f.calls, 0);
    assert.equal(f.state.jobs[0].attemptedAt, undefined);
  }
});

test('a manual compact retains native activity identity and cannot reschedule its own ordinary work', async () => {
  const f = fixture();
  f.agents[0].activityKey = 'launch:generation:1';
  const scheduler = f.make(); await scheduler.ready;
  await scheduler.observedTurn(f.agents[0]);
  assert.equal((await scheduler.compactNow('a', f.agents[0].revision!)).status, 'running');
  await waitForStatus(f, 'completed');
  f.agents[0].revision = new Date(f.time + 1).toISOString();
  await scheduler.observedTurn(f.agents[0], f.time + 2);
  assert.equal(f.state.jobs[0].status, 'completed');
  assert.equal(f.state.jobs[0].activityKey, 'launch:generation:1');
  assert.equal(f.calls, 1);
});

test('a changed native generation invalidates undo and prevents dispatch despite unchanged host revision', async () => {
  const f = fixture();
  f.agents[0].activityKey = 'launch:generation:1';
  const scheduler = f.make(); await scheduler.ready;
  await scheduler.observedTurn(f.agents[0]);
  await scheduler.skip('a', f.agents[0].revision!);
  const skip = f.state.jobs[0].skip!;
  f.agents[0].activityKey = 'other:generation:1';
  assert.equal(await scheduler.undoSkip('a', f.agents[0].revision!, skip.id), false);
  // Check an unskipped reservation as well.
  f.agents[0].activityKey = 'launch:generation:1';
  assert.equal(await scheduler.undoSkip('a', f.agents[0].revision!, skip.id), true);
  f.agents[0].activityKey = 'other:generation:1';
  f.advance(55 * 60000);
  await scheduler.tick();
  assert.equal(f.calls, 0);
  assert.equal(f.state.jobs[0].status, 'skipped');
});

test("Compact now works whether automation is off globally, for the provider or for the conversation", async () => {
  for (const change of [
    { enabled: false },
    { disabledProviders: ["claude"] },
    { conversationOff: true },
  ]) {
    const f = fixture();
    const s = f.make();
    await s.ready;
    if ("conversationOff" in change) await s.toggle("a", false);
    else f.config = { ...DEFAULT_SETTINGS, ...change };
    assert.equal((await s.compactNow("a", f.agents[0].revision!)).status, "running");
    await waitForStatus(f, "completed");
    assert.equal(f.calls, 1);
  }
});

test("a refused Compact now explains why", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  const revision = f.agents[0].revision!;
  assert.match((await s.compactNow("a", "stale")).detail, /changed/);
  f.agents[0].idle = false;
  assert.match((await s.compactNow("a", revision)).detail, /busy/);
  f.agents[0].idle = true;
  f.agents[0].eligible = false;
  assert.match((await s.compactNow("a", revision)).detail, /unavailable/);
  f.agents[0].eligible = true;
  f.config = null;
  assert.match((await s.compactNow("a", revision)).detail, /[Ss]ettings/);
  assert.equal(f.calls, 0);
});

test("a later native turn without a new host message earns a reservation; the same activity never does", async () => {
  const f = fixture();
  f.agents[0].activityKey = "launch:generation:1";
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  await s.invalidate("a");
  assert.equal(f.state.jobs[0].status, "skipped");
  f.advance(60_000);
  await s.observedTurn(f.agents[0], f.time);
  assert.equal(f.state.jobs[0].status, "skipped", "the same native activity is not rescheduled");
  f.agents[0].activityKey = "launch:generation:3";
  await s.observedTurn(f.agents[0], f.time);
  assert.equal(f.state.jobs[0].status, "scheduled");
  assert.equal(f.state.jobs[0].endedAt, f.time);
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 1);
});

test("lost acknowledgement retries return the same operation before live eligibility checks", async () => {
  const f = fixture(), s = f.make();
  await s.ready;
  let release!: () => void;
  // Resolves when the code under test reaches the held step.
  let reached!: () => void;
  const reaching = new Promise<void>(resolve => { reached = resolve; });
  let sends = 0;
  f.gateway.compact = async () => {
    sends++;
    await new Promise<void>(resolve => { release = resolve; reached(); });
    return { status: "completed", detail: "Completed" };
  };
  const revision = f.agents[0].revision!;
  const target = { sessionId: "native-a", activityKey: null };
  const accepted = await s.compactNow("a", revision, "request-a", target);
  await reaching;
  f.agents[0].idle = false;
  f.config = null;
  f.gateway.refresh = async () => { throw new Error("duplicate must not refresh"); };
  const duplicate = await s.compactNow("a", revision, "request-a", target);
  assert.equal(duplicate.code, "existing");
  assert.equal(duplicate.operationId, accepted.operationId);
  assert.equal(duplicate.operation?.state, "dispatching");
  assert.equal(f.state.operations.length, 1);
  assert.equal(sends, 1);
  release();
  await waitForStatus(f, "completed");
  assert.equal((await s.compactNow("a", revision, "request-a", target)).operation?.state, "succeeded");
  assert.equal((await s.operation("request-a"))?.state, "succeeded");
});

test("operation IDs reject different caller input, including target identity", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  const revision = f.agents[0].revision!;
  const target = { sessionId: "native-a", activityKey: null };
  await s.compactNow("a", revision, "request-a", target);
  await waitForStatus(f, "completed");
  for (const [agent, rev, scope] of [
    ["b", revision, target], ["a", "changed", target],
    ["a", revision, { ...target, activityKey: "changed" }],
    ["a", revision, { ...target, sessionId: "other" }],
    ["a", revision, undefined],
  ] as const) {
    const result = await s.compactNow(agent, rev, "request-a", scope);
    assert.equal(result.code, "idempotency_conflict");
    assert.equal(result.operationId, null);
  }
  assert.equal(f.calls, 1);
});

test("new requests reject stale native identity even when host revision is unchanged", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  f.agents[0].activityKey = "launch:generation:3";
  const result = await s.compactNow("a", f.agents[0].revision!, "request-a",
    { sessionId: "native-a", activityKey: "launch:generation:1" });
  assert.equal(result.code, "blocked");
  assert.equal(f.calls, 0);
  assert.equal(f.state.operations.length, 0);
});

test("operation completion survives reservation replacement and remains queryable without the agent", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  let release!: () => void;
  // Resolves when the code under test reaches the held step.
  let reached!: () => void;
  const reaching = new Promise<void>(resolve => { reached = resolve; });
  f.gateway.compact = async () => {
    await new Promise<void>(resolve => { release = resolve; reached(); });
    return { status: "completed", detail: "Completed" };
  };
  await s.compactNow("a", f.agents[0].revision!, "request-a");
  await reaching;
  f.advance(1000);
  f.agents[0].revision = new Date(f.time).toISOString();
  await s.observedTurn(f.agents[0]);
  assert.equal(f.state.jobs[0].status, "scheduled");
  assert.equal((await s.session("a"))?.activeOperation?.id, "request-a");
  assert.equal((await s.session("a"))?.status, "running");
  release();
  await f.until(() => f.state.operations.find((op) => op.id === "request-a")?.state !== "dispatching");
  assert.equal((await s.operation("request-a"))?.state, "succeeded");
  assert.equal(f.state.jobs[0].status, "scheduled");
  assert.equal((await s.session("a"))?.latestOperation?.id, "request-a");
  f.agents.splice(0);
  assert.equal((await s.operation("request-a"))?.state, "succeeded");
  assert.equal(await s.operation("missing"), null);
});

test("failed acceptance persistence never sends and the same submission can be retried", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  const write = f.store.write;
  f.store.write = async () => { throw new Error("disk full"); };
  await assert.rejects(s.compactNow("a", f.agents[0].revision!, "request-a"), /disk full/);
  assert.equal(f.calls, 0);
  assert.equal(f.state.operations.length, 0);
  f.store.write = write;
  assert.equal((await s.compactNow("a", f.agents[0].revision!, "request-a")).code, "accepted");
  await waitForStatus(f, "completed");
  assert.equal(f.calls, 1);
});

test("restart observes a dispatched operation and an old worker cannot overwrite recovery", async () => {
  const f = fixture(), first = f.make(); await first.ready;
  let release!: () => void;
  // Resolves when the code under test reaches the held step.
  let reached!: () => void;
  const reaching = new Promise<void>(resolve => { reached = resolve; });
  f.gateway.compact = async (_id, _agent, execution) => {
    await execution.checkpoint({ dispatchStartedAt: f.time });
    await new Promise<void>(resolve => { release = resolve; reached(); });
    return { status: "completed", detail: "Late completion" };
  };
  const revision = f.agents[0].revision!;
  await first.compactNow("a", revision, "request-a");
  await reaching;
  first.stop();
  const second = f.make(); await second.ready;
  assert.equal((await second.compactNow("a", revision, "request-a")).operation?.state, "observing");
  f.advance(180_001);
  await second.reconcile();
  release();
  // The stopped worker's run has ended, so whatever it would write is written.
  await first.idle();
  assert.equal((await second.operation("request-a"))?.state, "unknown");
});

test("a different ID cannot repeat compaction of the same activity", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  f.agents[0].activityKey = "launch:generation:1";
  await s.compactNow("a", f.agents[0].revision!, "request-a");
  await waitForStatus(f, "completed");
  assert.equal((await s.compactNow("a", f.agents[0].revision!, "request-b")).operationId, "request-a");
  assert.equal(f.calls, 1);
  assert.equal(f.state.operations.length, 1);
});

test("a fresh native generation can compact despite an unchanged host revision", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  f.agents[0].activityKey = "launch:generation:1";
  await s.compactNow("a", f.agents[0].revision!, "request-a");
  await waitForStatus(f, "completed");
  f.agents[0].activityKey = "launch:generation:2";
  const result = await s.compactNow("a", f.agents[0].revision!, "request-b",
    { sessionId: "native-a", activityKey: "launch:generation:2" });
  assert.equal(result.code, "accepted");
  await waitForStatus(f, "completed");
  assert.equal(f.calls, 2);
  assert.equal(f.state.operations.length, 2);
});

test("Compact now can repeat an activity only when the earlier attempt provably sent nothing", async () => {
  for (const [state, evidence, accepted] of [
    ["expired", undefined, true],
    ["failed", undefined, true],
    ["failed", { dispatchStartedAt: 1 }, false],
    ["unknown", undefined, false],
    ["succeeded", undefined, false],
  ] as const) {
    const f = fixture(), s = f.make(); await s.ready;
    f.agents[0].activityKey = "launch:generation:1";
    const target = { sessionId: "native-a", activityKey: "launch:generation:1" };
    f.state.operations.push({ id: "earlier", agentId: "a", revision: f.agents[0].revision!, target,
      kind: "automatic", state, createdAt: f.time, updatedAt: f.time, inputFingerprint: null,
      result: { code: "x", message: "earlier attempt" }, ...(evidence ? { evidence } : {}) });
    const result = await s.compactNow("a", f.agents[0].revision!, "request-b", target);
    assert.equal(result.code, accepted ? "accepted" : "existing", `${state} ${JSON.stringify(evidence)}`);
    if (accepted) { await waitForStatus(f, "completed"); assert.equal(f.calls, 1); }
    else assert.equal(f.calls, 0);
  }
});

test("automatic dispatch never repeats an activity, even one whose attempt sent nothing", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  f.agents[0].activityKey = "launch:generation:1";
  await s.observedTurn(f.agents[0]);
  f.state.operations.push({ id: "earlier", agentId: "a", revision: f.agents[0].revision!,
    target: { sessionId: "native-a", activityKey: "launch:generation:1" }, kind: "automatic", state: "expired",
    createdAt: f.time, updatedAt: f.time, inputFingerprint: null,
    result: { code: "expired_before_dispatch", message: "Compaction request expired before dispatch" } });
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 0);
  assert.equal(f.state.jobs[0].operationId, "earlier");
  assert.equal(f.state.jobs[0].status, "expired");
});

test("every write derives the jobs' attempt fields from their operations", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  let release!: () => void;
  // Resolves when the code under test reaches the held step.
  let reached!: () => void;
  const reaching = new Promise<void>(resolve => { reached = resolve; });
  f.gateway.compact = async (_id, _agent, execution) => {
    await execution.checkpoint({ dispatchStartedAt: f.time });
    await new Promise<void>(resolve => { release = resolve; reached(); });
    return { status: "completed", detail: "Completed" };
  };
  await s.compactNow("a", f.agents[0].revision!, "request-a");
  await reaching;
  assert.equal(f.state.jobs[0].status, "running");
  assert.equal(f.state.jobs[0].attemptedAt, f.state.operations[0].createdAt);
  release();
  await waitForStatus(f, "completed");
  assert.equal(f.state.jobs[0].detail, "Completed");
  // An attempt that sent nothing leaves no attemptedAt, which is what lets v1.0.2 retry it.
  const g = fixture(), t = g.make(); await t.ready;
  g.gateway.compact = async () => ({ status: "failed", detail: "Claude is still working" });
  await t.compactNow("a", g.agents[0].revision!, "request-a");
  await waitForStatus(g, "failed");
  assert.equal(g.state.jobs[0].attemptedAt, undefined);
  assert.equal(g.state.operations[0].result?.code, "failed_before_dispatch");
});

test("an unreadable observer keeps an automatic reservation instead of cancelling it", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  f.agents[0].activityKey = "launch:generation:1";
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const refresh = f.gateway.refresh;
  f.gateway.refresh = async id => ({ ...(await refresh(id))!, activityKey: null, observerUnreadable: true });
  await s.tick();
  assert.equal(f.state.jobs[0].status, "scheduled");
  assert.equal(f.calls, 0);
  f.gateway.refresh = refresh;
  await s.tick();
  await waitForStatus(f, "completed");
  assert.equal(f.calls, 1);
});

test("a Compact now request arriving during a worker pass starts without waiting for the next tick", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  // A pass already in progress read the state just before the request was saved.
  const read = f.store.read;
  let release!: () => void, gated = false;
  // Resolves when the code under test reaches the held step.
  let reached!: () => void;
  const reaching = new Promise<void>(resolve => { reached = resolve; });
  f.store.read = async () => {
    const value = await read();
    if (!gated) { gated = true; await new Promise<void>(resolve => { release = resolve; reached(); }); }
    return value;
  };
  const pass = s.reconcile();
  await reaching;
  assert.equal((await s.compactNow("a", f.agents[0].revision!, "request-a")).code, "accepted");
  release();
  await pass;
  await waitForStatus(f, "completed");
  assert.equal(f.calls, 1, "sent by the follow-up pass, with no tick");
});

test("unreadable settings during inspection keep an automatic reservation instead of reporting a change", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  f.gateway.readiness = async () => { f.config = null; return null; };
  await s.tick();
  assert.equal(f.state.jobs[0].status, "scheduled");
  assert.equal(f.calls, 0);
  f.gateway.readiness = async () => null;
  f.config = { ...DEFAULT_SETTINGS };
  await s.tick();
  await waitForStatus(f, "completed");
  assert.equal(f.calls, 1);
});

test("a scheduler stopped mid-request cannot put back state a newer instance replaced", async () => {
  const f = fixture(), first = f.make(); await first.ready;
  const refresh = f.gateway.refresh;
  let release!: () => void;
  // Resolves when the code under test reaches the held step.
  let reached!: () => void;
  const reaching = new Promise<void>(resolve => { reached = resolve; });
  f.gateway.refresh = async id => { await new Promise<void>(resolve => { release = resolve; reached(); }); return refresh(id); };
  const stale = first.compactNow("a", f.agents[0].revision!, "request-old");
  await reaching;
  first.stop();
  f.gateway.refresh = refresh;
  const second = f.make(); await second.ready;
  await second.compactNow("a", f.agents[0].revision!, "request-new");
  release();
  await assert.rejects(stale, Stopped);
  assert.deepEqual(f.state.operations.map(operation => operation.id), ["request-new"]);
});

test("a Compact now that cannot be prepared ends within seconds, unsent and retryable", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  const compact = f.gateway.compact;
  f.gateway.compact = async () => { throw new Error("observer preparation timed out"); };
  const revision = f.agents[0].revision!;
  assert.equal((await s.compactNow("a", revision, "request-a")).code, "accepted");
  // The failed attempt sets its own retry, due before the 10-second send deadline.
  await f.until(() => f.timers.pendingWithin(10_000) > 0);
  // Past the deadline, the retry's pass expires the request instead of sending it.
  f.advance(10_000);
  await f.timers.tick(10_000);
  await f.until(() => f.state.operations[0]?.state === "expired");
  const operation = await s.operation("request-a");
  assert.equal(operation?.state, "expired");
  assert.equal(operation?.result?.code, "expired_before_dispatch");
  f.gateway.compact = compact;
  assert.equal((await s.compactNow("a", revision, "request-b")).code, "accepted", "nothing was sent, so it can be tried again");
  s.stop();
});

test("a session awaiting resume is refused at once and holds its reservation, without a request that would fail later", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  await s.observedTurn(f.agents[0]);
  f.agents[0].resumeRequired = true;
  const refused = await s.compactNow("a", f.agents[0].revision!, "request-a");
  assert.equal(refused.status, "blocked");
  assert.match(refused.detail, /resume/i);
  assert.equal(refused.operation, null);
  assert.equal((await s.session("a"))?.status, "blocked");
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.state.jobs[0].status, "blocked");
  assert.match(f.state.jobs[0].detail, /resume/i);
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.calls, 0);
});

test("what already happened to an activity is answered before whether sending may start", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  f.agents[0].activityKey = "launch:generation:1";
  await s.observedTurn(f.agents[0]);
  const revision = f.agents[0].revision!;
  assert.equal((await s.compactNow("a", revision, "request-a")).code, "accepted");
  await waitForStatus(f, "completed");
  // After a plugin reload the same, already compacted activity awaits a resume.
  f.agents[0].resumeRequired = true;
  for (const live of [{ resumeRequired: true }, { idle: false }]) {
    Object.assign(f.agents[0], live);
    const again = await s.compactNow("a", revision, `request-${JSON.stringify(live)}`);
    assert.equal(again.code, "existing", JSON.stringify(live));
    assert.equal(again.operationId, "request-a");
  }
  assert.equal(f.calls, 1);
});

// An eligible idle Claude conversation whose native turn ended at `endedAt`.
function nativeAgent(f: ReturnType<typeof fixture>, agentId: string, activity = "1", endedAt = f.time): Observation {
  return {
    agentId, title: agentId, workspace: "/work", provider: "claude",
    revision: new Date(endedAt).toISOString(), tokens: 210_000, eligible: true, idle: true,
    sessionId: `native-${agentId}`, activityKey: `launch:${agentId}:${activity}`, observedEndedAt: endedAt,
  };
}
const reserved = (f: ReturnType<typeof fixture>) =>
  f.state.jobs.filter(job => job.status === "scheduled").map(job => job.agentId).sort();
// A host call held until `release`.
function held() {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  return { hold: () => hold, release };
}
const readsOf = (f: ReturnType<typeof fixture>, id: string) => f.counts.refreshes.filter(entry => entry === id);
// The order in which `calls` first appear in the host calls after the first
// `from`. Once every call has ended, a test checks from it that a call started
// only after another ended, including in the moment after a held one is released.
const firstAfter = (f: ReturnType<typeof fixture>, from: number, ...calls: string[]) =>
  f.hostCalls.slice(from).filter((call, index, all) => calls.includes(call) && all.indexOf(call) === index);
// Resolves once the scheduler waits on a host read under its five-second bound
// and `reached` holds, so a tick past the bound expires that read.
const readBound = (f: ReturnType<typeof fixture>, reached = () => true) =>
  f.until(() => reached() && f.timers.pendingWithin(INSPECT_TIMEOUT_MS) > 0);
// Moves the clock and the timers on together, so a bound that counts from an
// earlier moment is checked against the time that has passed since.
const elapse = async (f: ReturnType<typeof fixture>, ms: number) => {
  f.advance(ms);
  await f.timers.tick(ms);
};

test("a turn-ended event observes only that conversation, without listing every agent", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"), nativeAgent(f, "b"), nativeAgent(f, "c"));
  const s = f.make();
  await s.ready;
  f.counts.reset();
  await s.observe({ kind: "agent", agentId: "b" });
  assert.deepEqual(reserved(f), ["b"]);
  assert.equal(f.counts.lists, 0, "no agent listing for a single turn end");
  assert.deepEqual(f.counts.refreshes, ["b"]);
});

test("a conversation without observed native activity gets no reservation from observation", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observe({ kind: "agent", agentId: "a" });
  await s.observe({ kind: "full" });
  assert.equal(f.state.jobs.length, 0);
});

test("periodic observation scans every agent first, then only agents holding a reservation until a minute has passed", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"), nativeAgent(f, "b"), nativeAgent(f, "c"));
  const s = f.make();
  await s.ready;
  f.counts.reset();
  await s.observe({ kind: "periodic" });
  assert.equal(f.counts.lists, 1, "the first periodic pass is a full safety scan");
  assert.deepEqual(reserved(f), ["a", "b", "c"]);
  await s.invalidate("c");
  f.counts.reset();
  f.advance(10_000);
  await s.observe({ kind: "periodic" });
  assert.equal(f.counts.lists, 0, "no agent listing between full scans");
  assert.deepEqual(f.counts.refreshes.sort(), ["a", "b"], "only conversations that hold a reservation");
  f.advance(10_000);
  await s.invalidate("a");
  await s.invalidate("b");
  f.counts.reset();
  await s.observe({ kind: "periodic" });
  assert.equal(f.counts.lists, 0, "nothing to watch: no listing at all");
  assert.deepEqual(f.counts.refreshes, [], "nothing to watch: no read at all");
  f.advance(40_000);
  await s.observe({ kind: "periodic" });
  assert.equal(f.counts.lists, 1, "a full safety scan every minute");
});

test("the full safety scan still finds activity no event announced", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observe({ kind: "periodic" });
  // A reply ended while its turn-ended event was lost.
  f.agents.push(nativeAgent(f, "missed"));
  f.advance(10_000);
  await s.observe({ kind: "periodic" });
  assert.deepEqual(reserved(f), [], "the targeted pass does not look at unwatched conversations");
  f.advance(50_000);
  await s.observe({ kind: "periodic" });
  assert.deepEqual(reserved(f), ["missed"]);
});

test("periodic observation also watches a conversation with a pending operation", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"), nativeAgent(f, "b"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.gateway.compact = async () => { await gate; return { status: "completed", detail: "Completed boundary" }; };
  const s = f.make();
  await s.ready;
  await s.observe({ kind: "periodic" });
  await s.invalidate("a");
  await s.invalidate("b");
  const accepted = await s.compactNow("b", f.agents[1].revision!);
  assert.equal(accepted.status, "running");
  f.counts.reset();
  // Inside the 10-second manual send deadline, before the next full scan.
  f.advance(1_000);
  await s.observe({ kind: "periodic" });
  assert.equal(f.counts.lists, 0);
  // The worker may read b too; nothing else is read.
  assert.deepEqual([...new Set(f.counts.refreshes)], ["b"]);
  release();
  await f.until(() => f.state.operations[0]?.state === "succeeded");
  assert.equal(f.state.operations[0]?.state, "succeeded");
});

test("over a minute of ten-second passes with one reservation held, the directory is listed once", async () => {
  const f = fixture();
  // b has no observed reply, so only a holds a reservation.
  f.agents.splice(0, 1, nativeAgent(f, "a"), { ...nativeAgent(f, "b"), activityKey: null, observedEndedAt: null });
  const s = f.make();
  await s.ready;
  f.counts.reset();
  for (let pass = 0; pass < 6; pass++) {
    await s.observe({ kind: "periodic" });
    f.advance(10_000);
  }
  assert.deepEqual(reserved(f), ["a"]);
  assert.equal(f.counts.lists, 1, "only the full scan lists the directory");
  assert.deepEqual(f.counts.refreshes, ["a", "a", "a", "a", "a"],
    "each attention pass reads only the conversation needing attention");
});

test("an attention pass applies one conversation's newer reply although another's read times out", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"), nativeAgent(f, "b"));
  const s = f.make();
  await s.ready;
  await s.observe({ kind: "periodic" });
  assert.deepEqual(reserved(f), ["a", "b"]);
  const a = held();
  f.holdRefresh("a", a.hold);
  // b replied again while both still hold a reservation.
  f.advance(10_000);
  f.agents[1] = nativeAgent(f, "b", "2");
  try {
    const pass = s.observe({ kind: "periodic" });
    await readBound(f, () => f.counts.refreshes.at(-1) === "a");
    // Handled before the tick: the timeout rejects the pass while later due timers still run.
    const timedOut = assert.rejects(pass, "a's timeout is still reported");
    await f.timers.tick(INSPECT_TIMEOUT_MS);
    await timedOut;
    assert.equal(f.state.jobs.find(job => job.agentId === "b")?.activityKey, "launch:b:2",
      "b's newer reply is applied in the same pass");
    assert.equal(f.counts.lists, 1, "the attention pass lists nothing");
    // a's read is not cancelled: the next pass waits for it.
    f.advance(10_000);
    const from = f.hostCalls.length;
    const next = s.observe({ kind: "periodic" });
    await f.drained();
    assert.deepEqual(f.hostCalls.slice(from), [], "observation stays single-flight while a's read is still running");
    a.release();
    await next;
    assert.deepEqual(firstAfter(f, from, "read a ended", "read b"), ["read a ended", "read b"]);
    assert.deepEqual(readsOf(f, "b"), ["b", "b"]);
  } finally {
    a.release();
  }
});

test("an attention read that never ends stops blocking observation after a minute", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"));
  const s = f.make();
  await s.ready;
  await s.observe({ kind: "periodic" });
  f.holdRefresh("a", () => new Promise<void>(() => {}));
  f.advance(10_000);
  const pass = s.observe({ kind: "periodic" });
  await readBound(f);
  await elapse(f, INSPECT_TIMEOUT_MS);
  await assert.rejects(pass);
  f.addAgent("b");
  // Only the end of a's read or the single-flight bound starts b's read. The
  // bound counts from when the pass started, not from when its read timed out.
  const next = s.observe({ kind: "agent", agentId: "b" });
  await f.drained();
  assert.deepEqual(readsOf(f, "b"), [], "held while a's read runs");
  await elapse(f, FULL_SCAN_INTERVAL_MS - INSPECT_TIMEOUT_MS - 1);
  await f.drained();
  assert.deepEqual(readsOf(f, "b"), [], "still held a moment before the bound");
  await elapse(f, 1);
  await f.drained();
  assert.deepEqual(readsOf(f, "b"), ["b"], "observation resumes a minute after the pass started");
  await next;
});

test("a full scan reserves one listed conversation's finished reply although another's observation times out", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"), nativeAgent(f, "b"));
  const a = held();
  f.holdListed("a", a.hold);
  const s = f.make();
  await s.ready;
  try {
    // Its outcome is held from the start: the timeout rejects it during the tick.
    const scan = failureOf(s.observe({ kind: "full" }));
    await readBound(f);
    await f.timers.tick(INSPECT_TIMEOUT_MS);
    assert.ok(causesOf(await scan).some(cause => cause instanceof DeadlineExceeded), "a's timeout is still reported");
    assert.deepEqual(reserved(f), ["b"], "b's reservation is created by the scan");
    // a's observation is not cancelled: the next observation waits for it.
    const from = f.hostCalls.length;
    const next = s.observe({ kind: "agent", agentId: "b" });
    await f.drained();
    assert.deepEqual(f.hostCalls.slice(from), [], "observation stays single-flight while a's read is still running");
    a.release();
    await next;
    assert.deepEqual(firstAfter(f, from, "listed a ended", "read b"), ["listed a ended", "read b"]);
    assert.deepEqual(f.counts.refreshes, ["b"]);
  } finally {
    a.release();
  }
});

test("a batch of observations reads the state once and writes it once", async () => {
  const f = fixture();
  const agents = Array.from({ length: 25 }, (_, index) => nativeAgent(f, `agent-${index}`));
  const s = f.make();
  await s.ready;
  f.counts.reset();
  await s.observedTurns(agents.map(agent => ({ agent, endedAt: agent.observedEndedAt! })));
  assert.equal(f.state.jobs.length, 25);
  assert.equal(f.counts.reads, 1);
  assert.equal(f.counts.writes, 1);
});

test("unchanged activity writes nothing and an existing reservation is never duplicated or moved", async () => {
  const f = fixture();
  const agents = [nativeAgent(f, "a"), nativeAgent(f, "b")];
  const s = f.make();
  await s.ready;
  await s.observedTurns(agents.map(agent => ({ agent, endedAt: agent.observedEndedAt! })));
  const before = structuredClone(f.state.jobs);
  f.advance(30_000);
  f.counts.reset();
  await s.observedTurns([...agents, agents[0]].map(agent => ({ agent, endedAt: f.time })));
  assert.equal(f.counts.writes, 0);
  assert.deepEqual(f.state.jobs, before, "same activity keeps its original turn end");
  // New activity of one conversation replaces only its own reservation.
  const next = nativeAgent(f, "a", "2");
  await s.observedTurns([{ agent: next, endedAt: f.time }, { agent: agents[1], endedAt: f.time }]);
  assert.equal(f.state.jobs.length, 2);
  assert.equal(f.state.jobs.find(job => job.agentId === "a")?.activityKey, next.activityKey);
  assert.deepEqual(f.state.jobs.find(job => job.agentId === "b"), before.find(job => job.agentId === "b"));
});

test("a batch applies the same rules as a single turn end", async () => {
  const f = fixture();
  const busy = { ...nativeAgent(f, "busy"), idle: false };
  const ineligible = { ...nativeAgent(f, "ineligible"), eligible: false };
  const future = { ...nativeAgent(f, "future"), revision: new Date(f.time + 1).toISOString() };
  const s = f.make();
  await s.ready;
  await s.observedTurns([busy, ineligible, future].map(agent => ({ agent, endedAt: f.time })));
  assert.equal(f.state.jobs.length, 0);
});

test("a compaction due during a slow observation is dispatched on time", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"));
  const s = f.make();
  await s.ready;
  await s.observe({ kind: "agent", agentId: "a" });
  f.advance(55 * 60_000);
  const release = f.holdList();
  const scan = s.observe({ kind: "full" });
  await f.listingHeld();
  await s.tick();
  assert.equal(f.calls, 1, "the tick did not wait for the agent listing");
  release();
  await scan;
  await s.tick();
  assert.equal(f.calls, 1);
});

test("overlapping observations never run duplicate scans, and a turn end during a scan is not lost", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"), nativeAgent(f, "b"));
  const s = f.make();
  await s.ready;
  const release = f.holdList();
  const scans = [s.observe({ kind: "full" })];
  await f.listingHeld();
  // The reply of b ends while the full scan is already listing.
  f.agents[1] = nativeAgent(f, "b", "2");
  scans.push(s.observe({ kind: "periodic" }), s.observe({ kind: "full" }),
    s.observe({ kind: "agent", agentId: "b" }), s.observe({ kind: "agent", agentId: "b" }));
  await f.drained();
  assert.equal(f.counts.lists, 1, "the later requests wait while the listing runs");
  release();
  await Promise.all(scans);
  assert.equal(f.peakLists, 1, "one listing at a time");
  assert.ok(f.counts.lists + f.counts.refreshes.length <= 3,
    `queued requests were merged: ${JSON.stringify(f.counts)}`);
  assert.equal(f.state.jobs.find(job => job.agentId === "b")?.activityKey, "launch:b:2");
});

test("reading a conversation's status records its finished reply, so the controls need not wait for a scan", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"));
  const s = f.make();
  await s.ready;
  const row = await s.session("a");
  assert.equal(row?.status, "scheduled");
  assert.equal(row?.dueAt, f.time + 55 * 60_000);
  assert.deepEqual(reserved(f), ["a"]);
  f.counts.reset();
  await s.session("a");
  assert.equal(f.counts.writes, 0, "an unchanged activity is not written again");
});

test("an observation older than the recorded activity cannot replace it or undo its skip", async () => {
  const f = fixture();
  const older = nativeAgent(f, "a", "1");
  f.advance(1_000);
  const newer = nativeAgent(f, "a", "2");
  f.agents.splice(0, 1, newer);
  const s = f.make();
  await s.ready;
  // A status read records the newer reply; the user skips it.
  assert.equal((await s.session("a"))?.status, "scheduled");
  assert.equal(await s.skip("a", newer.revision!), true);
  // A scan that read the older reply before that commits late.
  await s.observedTurns([{ agent: older, endedAt: older.observedEndedAt! }]);
  assert.equal(f.state.jobs[0].activityKey, newer.activityKey);
  assert.equal(f.state.jobs[0].status, "skipped");
  // Observing the newer reply again keeps the skip.
  await s.observe({ kind: "agent", agentId: "a" });
  await s.session("a");
  assert.equal(f.state.jobs[0].status, "skipped");
  assert.equal(f.calls, 0);
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 0, "a skipped reply is never compacted");
});

test("a new launch or session generation still earns a reservation, whatever its native revision", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  await s.observedTurns([{ agent: nativeAgent(f, "a", "9"), endedAt: f.time }]);
  const relaunched = { ...nativeAgent(f, "a", "1"), activityKey: "relaunch:a:1" };
  await s.observedTurns([{ agent: relaunched, endedAt: f.time }]);
  assert.equal(f.state.jobs[0].activityKey, "relaunch:a:1");
});

test("a scan read before a session's new generation cannot replace its skipped reservation", async () => {
  const f = fixture();
  f.agents.splice(0, 1, { ...nativeAgent(f, "a"), activityKey: "launch:old-generation:9" });
  const s = f.make();
  await s.ready;
  const release = f.holdList();
  const scan = s.observe({ kind: "full" });
  await f.listingHeld();
  // The session reopened: a new generation's reply is recorded by a status read and skipped.
  f.advance(1_000);
  const current = { ...nativeAgent(f, "a"), activityKey: "launch:new-generation:1" };
  f.agents[0] = current;
  assert.equal((await s.session("a"))?.status, "scheduled");
  assert.equal(await s.skip("a", current.revision!), true);
  release();
  await scan;
  assert.equal(f.state.jobs[0].activityKey, "launch:new-generation:1");
  assert.equal(f.state.jobs[0].status, "skipped");
  await s.observe({ kind: "agent", agentId: "a" });
  assert.equal(f.state.jobs[0].status, "skipped");
  f.advance(55 * 60_000);
  await s.tick();
  assert.equal(f.calls, 0, "a skipped reply is never compacted");
});

test("a scan that times out keeps observation single-flight until its listing actually ends", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  const release = f.holdList();
  const first = s.observe({ kind: "full" });
  await readBound(f);
  await f.timers.tick(INSPECT_TIMEOUT_MS);
  await assert.rejects(first);
  const second = s.observe({ kind: "full" });
  await f.drained();
  assert.equal(f.counts.lists, 1, "no second listing while the first is still running");
  release();
  await second;
  assert.equal(f.peakLists, 1, "the queued scan starts only once the first listing has returned");
  assert.equal(f.counts.lists, 2, "the queued scan runs once the listing ends");
});

test("a listing that never ends stops blocking observation after a minute", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  const release = f.holdList();
  try {
    const first = s.observe({ kind: "full" });
    await readBound(f);
    await elapse(f, INSPECT_TIMEOUT_MS);
    await assert.rejects(first);
    // The single-flight bound counts from when the scan started.
    const next = s.observe({ kind: "agent", agentId: "a" });
    await elapse(f, FULL_SCAN_INTERVAL_MS - INSPECT_TIMEOUT_MS - 1);
    await f.drained();
    assert.deepEqual(f.counts.refreshes, [], "held a moment before the bound");
    await elapse(f, 1);
    await next;
    assert.deepEqual(f.counts.refreshes, ["a"], "observation resumes a minute after the scan started");
  } finally {
    release();
  }
});

test("a refresh that fails does not end single-flight while a sibling refresh is still running", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"), nativeAgent(f, "b"));
  const s = f.make();
  await s.ready;
  let heldB = false;
  const refreshed: string[] = [];
  const b = held();
  f.gateway.refresh = async (id) => {
    refreshed.push(id);
    f.hostCalls.push(`read ${id}`);
    try {
      if (id === "a") throw new Error("host failed for a");
      if (!heldB) { heldB = true; await b.hold(); }
      return structuredClone(f.agents.find(agent => agent.agentId === id) ?? null);
    } finally {
      f.hostCalls.push(`read ${id} ended`);
    }
  };
  const release = f.holdList();
  const full = s.observe({ kind: "full" });
  await f.listingHeld();
  // Two turn ends merge into one plan that refreshes a and b together.
  const merged = [s.observe({ kind: "agent", agentId: "a" }), s.observe({ kind: "agent", agentId: "b" })];
  release();
  await full;
  // a fails at once; the merged pass reports it when b's read times out.
  await readBound(f, () => heldB);
  await f.timers.tick(INSPECT_TIMEOUT_MS);
  await assert.rejects(merged[0], (error: unknown) => error instanceof AggregateError &&
    error.errors.some(cause => cause instanceof Error && cause.message === "host failed for a"));
  const from = f.hostCalls.length;
  const again = s.observe({ kind: "agent", agentId: "b" });
  await f.drained();
  assert.deepEqual(f.hostCalls.slice(from), [], "no second read of b while the first is running");
  b.release();
  await again;
  assert.deepEqual(firstAfter(f, from, "read b ended", "read b"), ["read b ended", "read b"]);
  assert.deepEqual(refreshed.filter(id => id === "b"), ["b", "b"]);
});

test("two conversations due in the same tick are both reserved and sent independently", async () => {
  const f = fixture();
  f.addAgent("b");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdCompact("a", async () => { started(); await gate; });
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  await s.observedTurn(f.agents[1]);
  f.advance(55 * 60_000);
  const tick = s.tick();
  await start;
  try {
    await f.until(() => f.sent.includes("b"));
    assert.deepEqual([...f.sent].sort(), ["a", "b"], "both are sent in that tick");
    assert.equal(f.state.operations.length, 2, "both are reserved in that tick");
    assert.deepEqual(
      f.state.operations.map((operation) => [operation.agentId, operation.kind]).sort(),
      [["a", "automatic"], ["b", "automatic"]]
    );
    assert.equal(f.state.jobs.find((job) => job.agentId === "a")?.status, "running");
  } finally {
    release();
  }
  await tick;
  await waitForAgentStatus(f, "a", "completed");
  await waitForAgentStatus(f, "b", "completed");
});

test("a conversation compacting does not stop a later tick from reserving another conversation", async () => {
  const f = fixture();
  f.addAgent("b");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdCompact("a", async () => { started(); await gate; });
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const first = s.tick();
  await start;
  // b only becomes due after a has started compacting.
  await s.observedTurn(f.agents[1]);
  f.advance(55 * 60_000);
  const second = s.tick();
  await second; // without waiting for a
  try {
    assert.deepEqual(f.sent, ["a", "b"]);
    assert.equal(f.state.jobs.find((job) => job.agentId === "b")?.status, "completed");
    assert.equal(f.state.jobs.find((job) => job.agentId === "a")?.status, "running");
  } finally {
    release();
  }
  await first;
  await waitForAgentStatus(f, "a", "completed");
});

test("a slow inspection of one conversation does not delay another conversation's automatic reservation", async () => {
  const f = fixture();
  f.addAgent("b");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let held = false;
  f.holdRefresh("a", async () => {
    if (held) return;
    held = true;
    started();
    await gate;
  });
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  await s.observedTurn(f.agents[1]);
  f.advance(55 * 60_000);
  const tick = s.tick();
  await start;
  try {
    await f.until(() => f.sent.includes("b"));
    assert.deepEqual(f.sent, ["b"], "b is sent while a's inspection is still held");
    await waitForAgentStatus(f, "b", "completed");
    assert.equal(f.state.jobs.find((job) => job.agentId === "b")?.status, "completed");
    assert.equal(f.state.jobs.find((job) => job.agentId === "a")?.status, "scheduled");
  } finally {
    release();
  }
  await tick;
  await waitForAgentStatus(f, "a", "completed");
  assert.deepEqual([...f.sent].sort(), ["a", "b"]);
  assert.equal(f.sent.filter((agentId) => agentId === "a").length, 1);
  assert.equal(f.sent.filter((agentId) => agentId === "b").length, 1);
});

test("a later tick skips only the conversation being inspected and reserves another", async () => {
  const f = fixture();
  f.addAgent("b");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let refreshes = 0;
  let held = false;
  f.holdRefresh("a", async () => {
    refreshes++;
    if (held) return;
    held = true;
    started();
    await gate;
  });
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const first = s.tick();
  await start;
  // b becomes due after the first tick has begun inspecting a, without moving
  // a past its delivery window.
  await s.observedTurn(f.agents[1]);
  f.state.jobs.find((job) => job.agentId === "b")!.endedAt = f.time - 55 * 60_000;
  const inspected = refreshes;
  const second = s.tick();
  await second; // while a's inspection is held
  try {
    assert.equal(refreshes, inspected, "the held conversation is not inspected again");
    assert.deepEqual(f.sent, ["b"], "b is sent while a's inspection is held");
    assert.equal(f.state.jobs.find((job) => job.agentId === "b")?.status, "completed");
  } finally {
    release();
  }
  await first;
  await waitForAgentStatus(f, "a", "completed");
  assert.deepEqual(f.sent, ["b", "a"]);
  assert.equal(f.sent.filter((agentId) => agentId === "a").length, 1);
  assert.equal(f.sent.filter((agentId) => agentId === "b").length, 1);
});

test("Compact now returns the pending automatic operation and sends once", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdCompact("a", async () => { started(); await gate; });
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const tick = s.tick();
  await start;
  try {
    const existing = await s.compactNow("a", f.agents[0].revision!);
    assert.equal(existing.code, "existing");
    assert.equal(existing.status, "running");
    assert.equal(existing.operation?.kind, "automatic");
    assert.equal(f.state.operations.length, 1);
    assert.deepEqual(f.sent, ["a"]);
  } finally {
    release();
  }
  await tick;
  await waitForStatus(f, "completed");
});

test("a due automatic reservation is not added while Compact now is pending", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdCompact("a", async () => { started(); await gate; });
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const manual = s.compactNow("a", f.agents[0].revision!);
  await start;
  try {
    await s.tick(); // without waiting for the manual send
    assert.equal(f.state.operations.length, 1);
    assert.equal(f.state.operations[0].kind, "manual");
    assert.deepEqual(f.sent, ["a"]);
  } finally {
    release();
  }
  await manual;
  await waitForStatus(f, "completed");
});

test("a Compact now accepted during a tick's inspection wins over the automatic reservation", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let held = false;
  f.holdRefresh("a", async () => {
    if (held) return;
    held = true;
    started();
    await gate;
  });
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const tick = s.tick();
  await start;
  const accepted = await s.compactNow("a", f.agents[0].revision!);
  assert.equal(accepted.code, "accepted");
  release();
  await tick;
  await waitForStatus(f, "completed");
  assert.equal(f.state.operations.length, 1);
  assert.equal(f.state.operations[0].kind, "manual");
  assert.deepEqual(f.sent, ["a"]);
});

test("a toggle during a tick's inspection prevents the automatic reservation", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdRefresh("a", async () => { started(); await gate; });
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const tick = s.tick();
  await start;
  assert.equal(await s.toggle("a", false), true);
  release();
  await tick;
  assert.equal(f.calls, 0);
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.state.jobs[0].status, "blocked");
  assert.equal(f.state.jobs[0].detail,
    "Automation policy or idle delay changed before dispatch");
});

test("a reservation that becomes late during a tick's inspection expires instead of blocking", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const read = f.store.read;
  let reads = 0;
  // Phase C reads after inspection; the window closing there is the race this checks.
  f.store.read = async () => {
    if (++reads === 3) f.advance(DELIVERY_WINDOW_MS + 1);
    return read();
  };
  await s.tick();
  assert.equal(f.calls, 0);
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.state.jobs[0].status, "expired");
  assert.equal(f.state.jobs[0].detail, "Delivery window passed during inspection");
});

test("a reservation whose session changed during inspection is not applied", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const read = f.store.read;
  let reads = 0;
  // Phase C reads fresh state; a different session there is not this reservation.
  f.store.read = async () => {
    if (++reads === 3) f.state.jobs[0].sessionId = "other-session";
    return read();
  };
  await s.tick();
  assert.equal(f.calls, 0);
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.state.jobs[0].status, "scheduled");
});

test("one conversation's failed host read does not stop another conversation's reservation", async () => {
  const f = fixture();
  f.addAgent("b");
  const refresh = f.gateway.refresh;
  f.gateway.refresh = async (id) => {
    if (id === "a") throw new Error("host read failed");
    return refresh(id);
  };
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  await s.observedTurn(f.agents[1]);
  f.advance(55 * 60_000);
  await s.tick();
  await waitForAgentStatus(f, "b", "completed");
  assert.deepEqual(f.sent, ["b"]);
  assert.equal(f.state.jobs.find((job) => job.agentId === "a")?.status, "scheduled");
  assert.equal(f.state.operations.filter((operation) => operation.agentId === "a").length, 0);
});

test("a slow host read in a tick does not hold up other conversations' state changes", async () => {
  const f = fixture();
  f.addAgent("b");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  f.holdRefresh("a", async () => { started(); await gate; });
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  const tick = s.tick();
  await start;
  const work = Promise.all([s.toggle("b", false), s.operation("missing")]);
  // Resolves while a's host read is held.
  const [changed, missing] = await work;
  release();
  await tick;
  assert.equal(changed, true);
  assert.equal(missing, null);
  assert.deepEqual(f.state.disabled, ["b"]);
  assert.equal(f.calls, 1);
});

test("one conversation's failed refresh does not drop another conversation's finished reply", async () => {
  const f = fixture();
  f.agents.splice(0, 1);
  const s = f.make();
  await s.ready;
  f.holdRefresh("a", async () => { throw new Error("host failed for a"); });
  const release = f.holdList();
  // A full scan that read no conversation is still running...
  const full = s.observe({ kind: "full" });
  await f.listingHeld();
  // ...when replies of a and b end; their turn-end observations merge.
  f.agents.push(nativeAgent(f, "a"), nativeAgent(f, "b"));
  const merged = [s.observe({ kind: "agent", agentId: "a" }), s.observe({ kind: "agent", agentId: "b" })];
  release();
  await full;
  await assert.rejects(merged[1], (error: unknown) => error instanceof AggregateError &&
    error.errors.some(cause => cause instanceof Error && cause.message === "host failed for a"), "the failure is still reported");
  assert.deepEqual(reserved(f), ["b"], "b's finished reply is reserved without waiting for a full scan");
});

test("a refresh that hangs past the deadline does not drop another conversation's finished reply", async () => {
  const f = fixture();
  f.agents.splice(0, 1);
  const s = f.make();
  await s.ready;
  const a = held();
  f.holdRefresh("a", a.hold);
  const release = f.holdList();
  try {
    // A full scan that read no conversation is still running...
    const full = s.observe({ kind: "full" });
    await f.listingHeld();
    // ...when replies of a and b end; their turn-end observations merge.
    f.agents.push(nativeAgent(f, "a"), nativeAgent(f, "b"));
    const merged = [s.observe({ kind: "agent", agentId: "a" }), s.observe({ kind: "agent", agentId: "b" })];
    release();
    await full;
    await readBound(f, () => f.counts.refreshes.includes("a"));
    // Handled before the tick: the timeout rejects the read while later due timers still run.
    const timedOut = assert.rejects(merged[1], "the timeout is still reported");
    await f.timers.tick(INSPECT_TIMEOUT_MS);
    await timedOut;
    assert.deepEqual(reserved(f), ["b"], "b's finished reply is reserved although a's read is still running");
    const from = f.hostCalls.length;
    const again = s.observe({ kind: "agent", agentId: "b" });
    await f.drained();
    assert.deepEqual(f.hostCalls.slice(from), [], "observation stays single-flight while a's read is still running");
    a.release();
    await again;
    assert.deepEqual(firstAfter(f, from, "read a ended", "read b"), ["read a ended", "read b"]);
  } finally {
    a.release();
  }
});

const busyAgent = (f: ReturnType<typeof fixture>, agentId: string, activityKey: string): Observation =>
  ({ ...nativeAgent(f, agentId), activityKey, observedEndedAt: null, idle: false });

test("a status read that sees a busy new session fences an older scan's finished reply", async () => {
  const f = fixture();
  f.agents.splice(0, 1, { ...nativeAgent(f, "a"), activityKey: "launch:old-generation:9" });
  const s = f.make();
  await s.ready;
  const release = f.holdList();
  // A scan reads the old session's finished reply...
  const scan = s.observe({ kind: "full" });
  await f.listingHeld();
  // ...then a newer status read sees a reopened session that is still working.
  f.advance(1_000);
  f.agents[0] = busyAgent(f, "a", "launch:new-generation:1");
  await s.session("a");
  release();
  await scan;
  assert.deepEqual(reserved(f), [], "the newer read wins: no reservation for the old reply");
});

test("a scan that sees a busy conversation fences an older status read's finished reply", async () => {
  const f = fixture();
  f.agents.splice(0, 1, { ...nativeAgent(f, "a"), activityKey: "launch:old-generation:9" });
  const s = f.make();
  await s.ready;
  const old = structuredClone(f.agents[0]);
  let releaseRead!: () => void;
  let reached!: () => void;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  f.gateway.refresh = async () => {
    await new Promise<void>(resolve => { releaseRead = resolve; reached(); });
    return structuredClone(old);
  };
  // A status read starts, but its host read ends late...
  const status = s.session("a");
  await reading;
  // ...after a newer scan saw the reopened session still working.
  f.advance(1_000);
  f.agents[0] = busyAgent(f, "a", "launch:new-generation:1");
  await s.observe({ kind: "full" });
  releaseRead();
  await status;
  assert.deepEqual(reserved(f), [], "the newer read wins: no reservation for the old reply");
});

test("every blocked row the scheduler builds carries its reason code; other rows carry none", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  const row = async () => (await s.session("a"))!;
  assert.deepEqual([(await row()).status, (await row()).blockedReason], ["blocked", "waiting_for_turn"]);
  await s.observedTurn(f.agents[0]);
  assert.deepEqual([(await row()).status, (await row()).blockedReason], ["scheduled", undefined]);
  f.config = null;
  assert.equal((await row()).blockedReason, "settings_unreadable");
  f.config = { ...DEFAULT_SETTINGS };
  f.agents[0].tokens = null;
  assert.equal((await row()).blockedReason, "context_usage_unknown");
  f.agents[0].tokens = 210_000;
  f.agents[0].resumeRequired = true;
  assert.equal((await row()).blockedReason, "resume_required");
  delete f.agents[0].resumeRequired;
  for (const reason of ["observer_starting", "observer_missing", "observer_unreadable", "claude_working",
    "waiting_for_reply", "cache_window_passed", "idle_delay_exceeds_cache"] as const) {
    f.gateway.readiness = async () => ({ reason, detail: "worded freely" });
    assert.deepEqual([(await row()).status, (await row()).blockedReason], ["blocked", reason]);
  }
  f.gateway.readiness = async () => null;
  f.agents[0].idle = false;
  assert.deepEqual([(await row()).status, (await row()).blockedReason], ["busy", undefined]);

  const stock = fixture(false), t = stock.make(); await t.ready;
  await t.observedTurn(stock.agents[0]);
  assert.equal((await t.session("a"))!.blockedReason, "observer_not_supported");
});

test("a starting or briefly unreadable observer keeps an automatic reservation untouched", async () => {
  for (const reason of ["observer_starting", "observer_unreadable"] as const) {
    const f = fixture(), s = f.make(); await s.ready;
    await s.observedTurn(f.agents[0]);
    f.advance(55 * 60_000);
    f.gateway.readiness = async () => ({ reason, detail: "not yet" });
    await s.tick();
    assert.equal(f.state.jobs[0].status, "scheduled");
    assert.equal(f.calls, 0);
    f.gateway.readiness = async () => null;
    await s.tick();
    await waitForStatus(f, "completed");
    assert.equal(f.calls, 1);
  }
});

test("a blocked reservation stores its reason code with its detail and shows it from storage", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  await s.observedTurn(f.agents[0]);
  f.advance(55 * 60_000);
  f.gateway.readiness = async () => ({ reason: "observer_missing", detail: "Claude observer unavailable" });
  await s.tick();
  assert.deepEqual([f.state.jobs[0].status, f.state.jobs[0].blockedReason], ["blocked", "observer_missing"]);
  // A policy change found during inspection is stored with its own code.
  f.gateway.readiness = async () => { f.config = { ...DEFAULT_SETTINGS, idleMinutes: 56 }; return null; };
  await s.tick();
  assert.deepEqual([f.state.jobs[0].status, f.state.jobs[0].blockedReason], ["blocked", "policy_changed"]);
  f.config = { ...DEFAULT_SETTINGS };
  f.gateway.readiness = async () => null;
  const row = (await s.session("a"))!;
  assert.deepEqual([row.status, row.detail, row.blockedReason],
    ["blocked", "Automation policy or idle delay changed before dispatch", "policy_changed"]);
  // A record from before codes, or with a code a later release added, shows no code.
  for (const blockedReason of [undefined, "added_later"]) {
    f.state.jobs[0].blockedReason = blockedReason;
    assert.equal((await s.session("a"))!.blockedReason, undefined);
  }
});

type Scheduler = ReturnType<ReturnType<typeof fixture>["make"]>;
// `lands` is the state a held write carries: started before the stop, it
// still lands once released, and nothing after it does.
type Stopping = { s: Scheduler; run: Promise<unknown>; held: { reached: Promise<void>; release(): void };
  lands?: () => State | undefined };
// A scheduler holding a reservation for "a", not yet due.
// Its readiness checks are counted, so a late one shows.
async function scheduled(f: ReturnType<typeof fixture>) {
  f.readiness(async () => null);
  const s = f.make();
  await s.ready;
  await s.observedTurn(f.agents[0]);
  return s;
}
// A scheduler whose reservation for "a" is due.
async function due(f: ReturnType<typeof fixture>) {
  const s = await scheduled(f);
  f.advance(55 * 60_000);
  return s;
}
// A scheduler with two operations past their retention, which the next
// tick's history cleanup removes one after the other.
async function retired(f: ReturnType<typeof fixture>) {
  const s = f.make({ receipts: true });
  await s.ready;
  for (const id of ["retired-1", "retired-2"])
    f.state.operations.push({ id, agentId: "a", revision: f.agents[0].revision!,
      target: { sessionId: "native-a", activityKey: null }, kind: "manual", state: "succeeded",
      createdAt: f.time - HISTORY_RETENTION_MS, updatedAt: f.time - HISTORY_RETENTION_MS, inputFingerprint: null,
      result: { code: "completed", message: "done" } });
  f.advance(HISTORY_SWEEP_INTERVAL_MS);
  return s;
}
// Each await of a pass, held: what the scheduler reaches while the test holds it.
const schedulerStopPoints: Record<string, (f: ReturnType<typeof fixture>) => Promise<Stopping>> = {
  "recovery's state read": async f => {
    const held = f.holdRead();
    const s = f.make();
    return { s, run: s.ready, held };
  },
  "recovery's state write": async f => {
    const held = f.holdWrite();
    const s = f.make();
    return { s, run: s.ready, held, lands: held.carries };
  },
  "recovery's settings read": async f => {
    const held = gate();
    f.holdSettings(0, held.pass);
    const s = f.make();
    return { s, run: s.ready, held };
  },
  "a tick queued behind another transaction's read": async f => {
    const s = await retired(f);
    const held = f.holdRead();
    // Its own outcome is not this test's; it ends with the stop too.
    void s.toggle("a", false).catch(() => {});
    return { s, run: s.tick(), held };
  },
  "a tick queued behind another transaction's write": async f => {
    const s = await retired(f);
    const held = f.holdWrite();
    void s.toggle("a", false).catch(() => {});
    return { s, run: s.tick(), held, lands: held.carries };
  },
  "the history cleanup's state read": async f => {
    const s = await retired(f);
    return { s, held: f.holdRead(), run: s.tick() };
  },
  "a receipt's removal": async f => {
    const s = await retired(f);
    return { s, held: f.holdReceipts("remove"), run: s.tick() };
  },
  "the history cleanup's write": async f => {
    const s = await retired(f);
    const held = f.holdWrite();
    return { s, held, lands: held.carries, run: s.tick() };
  },
  "the receipts' sweep": async f => {
    const s = await retired(f);
    return { s, held: f.holdReceipts("sweep"), run: s.tick() };
  },
  "the tick's settings read": async f => {
    const s = await due(f);
    const held = gate();
    f.holdSettings(0, held.pass);
    return { s, held, run: s.tick() };
  },
  "the reservation pass's state read": async f => {
    const s = await due(f);
    // The pass reads state once it has read the settings.
    const before = f.counts.settingsEnded;
    return { s, held: f.holdRead(() => f.counts.settingsEnded > before), run: s.tick() };
  },
  "a due conversation's host read": async f => {
    const s = await due(f);
    const held = gate();
    f.holdRefresh("a", held.pass);
    return { s, held, run: s.tick() };
  },
  "a due conversation's readiness check": async f => {
    const s = await due(f);
    const held = gate();
    f.readiness(async () => { await held.pass(); return null; });
    return { s, held, run: s.tick() };
  },
  "a due conversation's second settings read": async f => {
    const s = await due(f);
    const held = gate();
    f.holdSettings(1, held.pass);
    return { s, held, run: s.tick() };
  },
  "the reservation's state read": async f => {
    const s = await due(f);
    // The reservation reads state once its conversation's readiness is checked.
    const before = f.counts.readiness;
    return { s, held: f.holdRead(() => f.counts.readiness > before), run: s.tick() };
  },
  "a full scan's listing": async f => {
    f.agents.splice(0, 1, nativeAgent(f, "a"));
    const s = f.make();
    await s.ready;
    const release = f.holdList();
    return { s, held: { reached: f.listingHeld(), release }, run: s.observe({ kind: "full" }) };
  },
  "a listed conversation's observation": async f => {
    f.agents.splice(0, 1, nativeAgent(f, "a"));
    const s = f.make();
    await s.ready;
    const held = gate();
    f.holdListed("a", held.pass);
    return { s, held, run: s.observe({ kind: "full" }) };
  },
  "an attention pass's state read": async f => {
    f.agents.splice(0, 1, nativeAgent(f, "a"));
    const s = f.make();
    await s.ready;
    // The first periodic pass is a full scan; the next within a minute is not.
    await s.observe({ kind: "periodic" });
    f.advance(10_000);
    return { s, held: f.holdRead(), run: s.observe({ kind: "periodic" }) };
  },
  "an attention pass's host read": async f => {
    f.agents.splice(0, 1, nativeAgent(f, "a"));
    const s = f.make();
    await s.ready;
    await s.observe({ kind: "periodic" });
    f.advance(10_000);
    const held = gate();
    f.holdRefresh("a", held.pass);
    return { s, held, run: s.observe({ kind: "periodic" }) };
  },
  "the observed turn's state read": async f => {
    f.agents.splice(0, 1, nativeAgent(f, "a"));
    const s = f.make();
    await s.ready;
    return { s, held: f.holdRead(), run: s.observe({ kind: "agent", agentId: "a" }) };
  },
  "the observed turn's write": async f => {
    f.agents.splice(0, 1, nativeAgent(f, "a"));
    const s = f.make();
    await s.ready;
    const held = f.holdWrite();
    return { s, held, lands: held.carries, run: s.observe({ kind: "agent", agentId: "a" }) };
  },
  "a status read's host read": async f => {
    const s = f.make();
    await s.ready;
    const held = gate();
    f.holdRefresh("a", held.pass);
    return { s, held, run: s.session("a") };
  },
  "a status row's readiness check": async f => {
    const s = await scheduled(f);
    const held = gate();
    f.readiness(async () => { await held.pass(); return null; });
    return { s, held, run: s.session("a") };
  },
  "the conversation list's listing": async f => {
    const s = f.make();
    await s.ready;
    const release = f.holdList();
    return { s, held: { reached: f.listingHeld(), release }, run: s.list() };
  },
  "Compact now's settings read": async f => {
    const s = f.make();
    await s.ready;
    const held = gate();
    f.holdSettings(0, held.pass);
    return { s, held, run: s.compactNow("a", f.agents[0].revision!, "request-a") };
  },
  "Compact now's host read": async f => {
    const s = f.make();
    await s.ready;
    const held = gate();
    f.holdRefresh("a", held.pass);
    return { s, held, run: s.compactNow("a", f.agents[0].revision!, "request-a") };
  },
  "a skip's host read": async f => {
    const s = await scheduled(f);
    const held = gate();
    f.holdRefresh("a", held.pass);
    return { s, held, run: s.skip("a", f.agents[0].revision!) };
  },
};

// One test each, so a call that outlives its stop fails at the runner's bound
// on its own.
for (const [at, stopAt] of Object.entries(schedulerStopPoints)) {
  test(`a scheduler stopped at ${at} ends the call at once, and reads, writes, submits, removes and reports nothing`, async (t) => {
    const scope = cleanupScope(t);
    const f = fixture();
    const { s, run, held, lands } = await stopAt(f);
    scope.defer(() => s.stop());
    // Its outcome is checked once it settles; a rejection is not left unhandled meanwhile.
    const settled = run.then(() => null, (error: unknown) => error);
    await held.reached;
    // Taken before stop(), so what stop() itself did counts too.
    const before = (state: State = f.state) => JSON.stringify({ state, reads: f.counts.reads,
      writes: f.counts.writes, settings: f.counts.settings, readiness: f.counts.readiness,
      refreshes: f.counts.refreshes.length, lists: f.counts.lists, sent: f.calls,
      receipts: f.receiptCalls.length, errors: defects(f.errors) });
    const snapshot = before(lands?.());
    s.stop();
    assert.equal(f.timers.pending, 0, `${at}: stopping ends every wait and clears its timer`);
    // The call ends while its step is still held; one still waiting fails
    // here, at the runner's bound.
    const outcome = await settled;
    assert.ok(outcome === null || outcome instanceof Stopped, `${at}: the call ends by stopping, not ${String(outcome)}`);
    assert.equal(f.timers.pending, 0, `${at}: the ended call armed nothing on its way out`);
    await s.idle();
    held.release();
    // What the released step does next has run once the queued callbacks have.
    await f.drained();
    assert.equal(before(), snapshot, `${at}: nothing is read, written, submitted, removed or reported`);
    assert.equal(f.timers.pending, 0, `${at}: no wait is armed`);
  });
}

// An opaque `Timers` may return no handle; clearing by what setTimeout returned
// still clears the timer, as `bounded()` does.
test("with timers that return no handle, the scheduler clears every timer it arms, the single-flight one too", async () => {
  const f = fixture();
  const opaque = undefinedHandleTimers();
  let armed = 0;
  const s = f.make({ timers: { ...opaque, setTimeout: (callback, ms) => { armed++; return opaque.setTimeout(callback, ms); } } });
  await s.ready;
  await s.observe({ kind: "full" });
  await f.drained();
  s.stop();
  assert.ok(armed > 0, "the pass armed its bounds and the single-flight timer");
  assert.deepEqual(opaque.cleared, Array.from({ length: armed }, () => undefined),
    "each one is cleared by the handle it returned");
});

test("a stopped scheduler starts no read, write, host call or timer for a call made after it stopped", async () => {
  const f = fixture();
  const s = await scheduled(f);
  s.stop();
  f.counts.reset();
  const revision = f.agents[0].revision!;
  const calls: [string, () => Promise<unknown>][] = [
    ["tick", () => s.tick()], ["reconcile", () => s.reconcile()],
    ["full scan", () => s.observe({ kind: "full" })], ["periodic pass", () => s.observe({ kind: "periodic" })],
    ["turn end", () => s.observe({ kind: "agent", agentId: "a" })], ["observed turn", () => s.observedTurn(f.agents[0])],
    ["status", () => s.session("a")], ["list", () => s.list()], ["toggle", () => s.toggle("a", false)],
    ["skip", () => s.skip("a", revision)], ["undo", () => s.undoSkip("a", revision, "skip")],
    ["operation", () => s.operation("request-a")], ["Compact now", () => s.compactNow("a", revision, "request-a")],
    ["invalidate", () => s.invalidate("a")],
  ];
  for (const [name, call] of calls) {
    const outcome = await call().then(() => null, (error: unknown) => error);
    assert.ok(outcome === null || outcome instanceof Stopped, `${name} ends by stopping, not ${String(outcome)}`);
  }
  await f.drained();
  const { reads, writes, lists, settings, readiness, refreshes } = f.counts;
  assert.deepEqual({ reads, writes, lists, settings, readiness, refreshes },
    { reads: 0, writes: 0, lists: 0, settings: 0, readiness: 0, refreshes: [] },
    "nothing is read, written or asked of the host");
  assert.deepEqual([f.calls, f.receiptCalls.length, defects(f.errors).length, f.timers.pending], [0, 0, 0, 0]);
});

// What a pass delivers: every failure it met by the time it completes, in one
// group, and each later one to the error owner as it arrives.
const failureOf = (outcome: Promise<unknown>) => outcome.then(() => null, (error: unknown) => error);
const causesOf = (error: unknown) => {
  assert.ok(error instanceof AggregateError, `the pass fails with every failure it met, not ${String(error)}`);
  return error.errors;
};

test("an observation pass delivers every failure it met, not only the first", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  const first = new Error("EIO: a"), second = new Error("EIO: b");
  f.gateway.list = async observe => { observe(Promise.reject(first)); observe(Promise.reject(second)); };
  assert.deepEqual(causesOf(await failureOf(s.observe({ kind: "full" }))), [first, second]);
  assert.deepEqual(f.errors, [], "on-time failures go to the caller, not also to the owner");
});

test("a pass with an observation that times out and one that fails delivers both", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  const fault = new Error("EACCES: ledger");
  f.gateway.list = async observe => { observe(new Promise<never>(() => {})); observe(Promise.reject(fault)); };
  const outcome = failureOf(s.observe({ kind: "full" }));
  await readBound(f);
  await f.timers.tick(INSPECT_TIMEOUT_MS);
  const causes = causesOf(await outcome);
  assert.equal(causes.length, 2);
  assert.ok(causes.includes(fault), "the real fault is delivered");
  assert.ok(causes.some(cause => cause instanceof DeadlineExceeded), "and so is the timeout beside it");
});

test("a listing or observation that fails after the pass stopped waiting on it reaches the error owner", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  let failListing!: (error: Error) => void;
  let failRead!: (error: Error) => void;
  f.gateway.list = observe => {
    observe(new Promise<never>((_resolve, reject) => { failRead = reject; }));
    return new Promise<never>((_resolve, reject) => { failListing = reject; });
  };
  const outcome = failureOf(s.observe({ kind: "full" }));
  await readBound(f);
  await f.timers.tick(INSPECT_TIMEOUT_MS);
  assert.ok(causesOf(await outcome).every(cause => cause instanceof DeadlineExceeded), "both waits timed out");
  assert.deepEqual(f.errors, []);
  const listing = new Error("EIO: listing page"), read = new Error("EIO: ledger read");
  failListing(listing);
  failRead(read);
  await f.drained();
  assert.deepEqual(f.errors, [listing, read], "each late failure is handed to the owner as it arrives");
});

test("an observation that starts and fails after its pass completed reaches the error owner", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  const page = gate();
  const late = new Error("EIO: ledger read on a later page");
  f.gateway.list = async observe => { await page.pass(); observe(Promise.reject(late)); };
  const outcome = failureOf(s.observe({ kind: "full" }));
  await page.reached;
  await readBound(f);
  await f.timers.tick(INSPECT_TIMEOUT_MS);
  assert.ok(causesOf(await outcome)[0] instanceof DeadlineExceeded, "the listing timed out");
  page.release();
  await f.drained();
  assert.deepEqual(f.errors, [late]);
});

test("a full scan whose listing page fails records nothing, and still delivers the failures of reads already started", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"));
  const s = f.make();
  await s.ready;
  const read = new Error("EIO: ledger of b"), page = new Error("listing page failed");
  f.gateway.list = async observe => {
    observe(Promise.resolve(structuredClone(f.agents[0])));
    observe(Promise.reject(read));
    throw page;
  };
  const causes = causesOf(await failureOf(s.observe({ kind: "full" })));
  assert.deepEqual(new Set(causes), new Set([page, read]), "neither failure hides the other");
  assert.deepEqual(reserved(f), [], "a partial full scan records nothing");
});

test("an observation that fails while the settings list is still paging is reported, and the list fails", async () => {
  for (const later of ["ends", "fails"] as const) {
    const f = fixture();
    const s = f.make();
    await s.ready;
    const page = gate();
    const observation = new Error("EIO: ledger"), listing = new Error("listing page failed");
    f.gateway.list = async observe => {
      observe(Promise.reject(observation));
      await page.pass();
      if (later === "fails") throw listing;
    };
    const outcome = failureOf(s.list());
    await page.reached;
    await f.drained();
    assert.deepEqual(f.errors, [observation], `${later}: the failure is reported while paging goes on`);
    page.release();
    const error = await outcome;
    assert.ok(error instanceof Error, `${later}: the list fails, so the screen offers Retry`);
    if (later === "fails") assert.equal(error, listing, "a failed listing takes precedence");
    assert.deepEqual(f.errors, [observation], `${later}: the observation's failure is reported once`);
  }
});

test("a host read already issued when the scheduler stops still has its failure reported", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  let fail!: (error: Error) => void;
  const reading = gate();
  f.gateway.refresh = async () => { await reading.pass(); return new Promise<never>((_resolve, reject) => { fail = reject; }); };
  const status = failureOf(s.session("a"));
  await reading.reached;
  reading.release();
  await f.drained();
  s.stop();
  assert.ok(await status instanceof Stopped, "the call ends at the stop");
  const defect = new TypeError("host read broke");
  fail(defect);
  await f.drained();
  assert.deepEqual(defects(f.errors), [String(defect)], "the read's own failure is still handed on");
});
