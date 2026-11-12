import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  type Settings,
} from "../shared/settings";
import { createScheduler } from "./scheduler";
import { DELIVERY_WINDOW_MS } from "./policy";
import { Refusal, type Gateway, type Observation, type State, type StateStore } from "./model";

function fixture(automatic = true) {
  let time = 1_000_000;
  let config: Settings | null = { ...DEFAULT_SETTINGS };
  let state: State = { version: 1, disabled: [], jobs: [], operations: [] };
  let calls = 0;
  const sent: string[] = [];
  const compactHolds = new Map<string, () => Promise<void>>();
  const refreshHolds = new Map<string, () => Promise<void>>();
  // Resource use the optimization promises to bound.
  const counts = {
    reads: 0, writes: 0, lists: [] as Array<string[] | undefined>, refreshes: [] as string[],
    reset() { this.reads = 0; this.writes = 0; this.lists = []; this.refreshes = []; },
  };
  let listGate: Promise<void> | null = null;
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
      return structuredClone(state);
    },
    write: async (next) => {
      counts.writes++;
      state = structuredClone(next);
    },
  };
  const compact: Gateway["compact"] = async (agentId) => {
    calls++;
    sent.push(agentId);
    await compactHolds.get(agentId)?.();
    return { status: "completed", detail: "same session, completed boundary" };
  };
  const refresh: Gateway["refresh"] = async (id) => {
    counts.refreshes.push(id);
    await refreshHolds.get(id)?.();
    return structuredClone(agents.find((a) => a.agentId === id) ?? null);
  };
  const gateway: Gateway = {
    list: async (filter?: { agentIds?: readonly string[] }) => {
      counts.lists.push(filter?.agentIds ? [...filter.agentIds].sort() : undefined);
      const listed = structuredClone(filter?.agentIds
        ? agents.filter((a) => filter.agentIds!.includes(a.agentId)) : agents);
      if (listGate) await listGate;
      return listed;
    },
    refresh,
    compact,
    ...(automatic ? { automatic: async (expected: Observation) => compact(expected.agentId) } : {}),
  };
  const make = () =>
    createScheduler({
      store,
      gateway,
      settings: async () => config,
      now: () => time,
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
    counts,
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

async function waitForAgentStatus(f: ReturnType<typeof fixture>, agentId: string,
  status: State["jobs"][number]["status"]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (f.state.jobs.find((job) => job.agentId === agentId)?.status === status) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${agentId} ${status}; current status is ${
    f.state.jobs.find((job) => job.agentId === agentId)?.status}`);
}

// Resolve to null if work is still pending after ms; the test then fails on the
// missing progress instead of hanging on a queue that should not be held.
async function within<T>(work: Promise<T>, ms = 250): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  assert.equal(await s.undoSkip("a", skipped.revision!, skipped.undoSkip!.id), true);
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
    await execution!.checkpoint({ dispatchStartedAt: f.time });
    return new Promise(() => {});
  };
  f.advance(55 * 60_000);
  void s.tick();
  while (f.state.operations[0]?.evidence?.dispatchStartedAt === undefined)
    await new Promise<void>(resolve => setImmediate(resolve));
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
  const second = await within(secondRequest);
  release();
  const secondResult = second ?? await secondRequest;
  const firstResult = await first;
  assert.equal(secondResult.code, "accepted");
  assert.equal(firstResult.code, "existing");
  assert.equal(firstResult.operationId, "request-b");
  assert.equal(f.state.operations.length, 1);
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
  const second = await within(secondRequest);
  release();
  const secondResult = second ?? await secondRequest;
  const firstResult = await first;
  assert.equal(secondResult.code, "accepted");
  assert.equal(firstResult.code, "existing");
  assert.equal(firstResult.operationId, secondResult.operationId);
  assert.equal(f.state.operations.length, 1);
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
  const early = await within(work.then(() => true));
  release();
  const [session, changed, missing, compact] = await work;
  assert.equal(early, true, "other conversations resolve while a's host read is held");
  assert.equal(session?.agentId, "b");
  assert.equal(changed, true);
  assert.equal(missing, null);
  assert.equal(compact.code, "accepted");
  await waitForAgentStatus(f, "b", "completed");
  assert.equal(f.sent.filter((agentId) => agentId === "b").length, 1);
  await pending;
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

  const request = scheduler.compactNow("a", f.agents[0].revision!);
  const first = await Promise.race([
    request,
    new Promise<"rpc-timeout">((resolve) => setTimeout(() => resolve("rpc-timeout"), 10)),
  ]);
  release();
  await waitForStatus(f, "completed");

  if (first === "rpc-timeout")
    assert.fail("the RPC waited for compaction instead of acknowledging the persisted running job");
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
  await s.tick();
  assert.equal(f.calls, 0);
});

test("a known short TTL or expired cache prevents automatic dispatch", async () => {
  const f = fixture();
  let blocked: string | null =
    "Idle delay exceeds the 5-minute cache window (transcript)";
  f.gateway.readiness = async () => blocked;
  const scheduler = f.make();
  await scheduler.ready;
  await scheduler.observedTurn(f.agents[0]);
  f.advance(55 * 60000);
  await scheduler.tick();
  assert.equal(f.calls, 0);
  assert.equal(f.state.jobs[0].attemptedAt, undefined);
  assert.equal((await scheduler.list())[0].detail, blocked);
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
  let sends = 0;
  f.gateway.compact = async () => {
    sends++;
    await new Promise<void>(resolve => { release = resolve; });
    return { status: "completed", detail: "Completed" };
  };
  const revision = f.agents[0].revision!;
  const target = { sessionId: "native-a", activityKey: null };
  const accepted = await s.compactNow("a", revision, "request-a", target);
  while (!release) await new Promise<void>(resolve => setImmediate(resolve));
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
  f.gateway.compact = async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { status: "completed", detail: "Completed" };
  };
  await s.compactNow("a", f.agents[0].revision!, "request-a");
  while (!release) await new Promise<void>(resolve => setImmediate(resolve));
  f.advance(1000);
  f.agents[0].revision = new Date(f.time).toISOString();
  await s.observedTurn(f.agents[0]);
  assert.equal(f.state.jobs[0].status, "scheduled");
  assert.equal((await s.session("a"))?.activeOperation?.id, "request-a");
  assert.equal((await s.session("a"))?.status, "running");
  release();
  for (let i = 0; i < 100 && (await s.operation("request-a"))?.state === "dispatching"; i++)
    await new Promise<void>(resolve => setImmediate(resolve));
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
  f.gateway.compact = async (_id, _agent, execution) => {
    await execution!.checkpoint({ dispatchStartedAt: f.time });
    await new Promise<void>(resolve => { release = resolve; });
    return { status: "completed", detail: "Late completion" };
  };
  const revision = f.agents[0].revision!;
  await first.compactNow("a", revision, "request-a");
  while (!release) await new Promise<void>(resolve => setImmediate(resolve));
  first.stop();
  const second = f.make(); await second.ready;
  assert.equal((await second.compactNow("a", revision, "request-a")).operation?.state, "observing");
  f.advance(180_001);
  await second.reconcile();
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
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
  f.gateway.compact = async (_id, _agent, execution) => {
    await execution!.checkpoint({ dispatchStartedAt: f.time });
    await new Promise<void>(resolve => { release = resolve; });
    return { status: "completed", detail: "Completed" };
  };
  await s.compactNow("a", f.agents[0].revision!, "request-a");
  while (!release) await new Promise<void>(resolve => setImmediate(resolve));
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
  f.store.read = async () => {
    const value = await read();
    if (!gated) { gated = true; await new Promise<void>(resolve => { release = resolve; }); }
    return value;
  };
  const pass = s.reconcile();
  while (!release) await new Promise<void>(resolve => setImmediate(resolve));
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
  f.gateway.refresh = async id => { await new Promise<void>(resolve => { release = resolve; }); return refresh(id); };
  const stale = first.compactNow("a", f.agents[0].revision!, "request-old");
  while (!release) await new Promise<void>(resolve => setImmediate(resolve));
  first.stop();
  f.gateway.refresh = refresh;
  const second = f.make(); await second.ready;
  await second.compactNow("a", f.agents[0].revision!, "request-new");
  release();
  await assert.rejects(stale, /Plugin stopped/);
  assert.deepEqual(f.state.operations.map(operation => operation.id), ["request-new"]);
});

test("a Compact now that cannot be prepared ends within seconds, unsent and retryable", async () => {
  const f = fixture(), s = f.make(); await s.ready;
  const compact = f.gateway.compact;
  let attempts = 0;
  f.gateway.compact = async () => { attempts++; throw new Error("observer preparation timed out"); };
  const revision = f.agents[0].revision!;
  assert.equal((await s.compactNow("a", revision, "request-a")).code, "accepted");
  for (let i = 0; i < 100 && attempts === 0; i++) await new Promise<void>(resolve => setImmediate(resolve));
  f.advance(10_000);
  for (let i = 0; i < 100 && (await s.operation("request-a"))?.state !== "expired"; i++) {
    await s.reconcile();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
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
  // After a plugin reload on Paseo 0.14 the same, already compacted activity awaits a resume.
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
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("a turn-ended event observes only that conversation, without listing every agent", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"), nativeAgent(f, "b"), nativeAgent(f, "c"));
  const s = f.make();
  await s.ready;
  f.counts.reset();
  await s.observe({ kind: "agent", agentId: "b" });
  assert.deepEqual(reserved(f), ["b"]);
  assert.deepEqual(f.counts.lists, [], "no agent listing for a single turn end");
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
  assert.deepEqual(f.counts.lists, [undefined], "the first periodic pass is a full safety scan");
  assert.deepEqual(reserved(f), ["a", "b", "c"]);
  await s.invalidate("c");
  f.counts.reset();
  f.advance(10_000);
  await s.observe({ kind: "periodic" });
  assert.deepEqual(f.counts.lists, [["a", "b"]], "only conversations that hold a reservation");
  f.advance(10_000);
  await s.invalidate("a");
  await s.invalidate("b");
  f.counts.reset();
  await s.observe({ kind: "periodic" });
  assert.deepEqual(f.counts.lists, [], "nothing to watch: no listing at all");
  f.advance(40_000);
  await s.observe({ kind: "periodic" });
  assert.deepEqual(f.counts.lists, [undefined], "a full safety scan every minute");
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
  assert.deepEqual(f.counts.lists, [["b"]]);
  release();
  for (let attempt = 0; attempt < 100 && f.state.operations[0]?.state !== "succeeded"; attempt++) await settle();
  assert.equal(f.state.operations[0]?.state, "succeeded");
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
  await settle();
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
  await settle();
  // The reply of b ends while the full scan is already listing.
  f.agents[1] = nativeAgent(f, "b", "2");
  scans.push(s.observe({ kind: "periodic" }), s.observe({ kind: "full" }),
    s.observe({ kind: "agent", agentId: "b" }), s.observe({ kind: "agent", agentId: "b" }));
  await settle();
  assert.equal(f.counts.lists.length, 1, "one listing at a time");
  release();
  await Promise.all(scans);
  assert.ok(f.counts.lists.length + f.counts.refreshes.length <= 3,
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
  await settle();
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
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const release = f.holdList();
    const first = s.observe({ kind: "full" });
    await settle();
    mock.timers.tick(5_000);
    await assert.rejects(first);
    const second = s.observe({ kind: "full" });
    await settle();
    assert.equal(f.counts.lists.length, 1, "no second listing while the first is still running");
    release();
    await second;
    assert.equal(f.counts.lists.length, 2, "the queued scan runs once the listing ends");
  } finally {
    mock.timers.reset();
  }
});

test("a listing that never ends stops blocking observation after a minute", async () => {
  const f = fixture();
  const s = f.make();
  await s.ready;
  mock.timers.enable({ apis: ["setTimeout"] });
  const release = f.holdList();
  try {
    const first = s.observe({ kind: "full" });
    await settle();
    mock.timers.tick(5_000);
    await assert.rejects(first);
    mock.timers.tick(60_000);
    await settle();
    const second = s.observe({ kind: "agent", agentId: "a" });
    await settle();
    assert.deepEqual(f.counts.refreshes, ["a"], "observation resumes instead of stalling for good");
    await second;
  } finally {
    release();
    mock.timers.reset();
  }
});

test("a refresh that fails does not end single-flight while a sibling refresh is still running", async () => {
  const f = fixture();
  f.agents.splice(0, 1, nativeAgent(f, "a"), nativeAgent(f, "b"));
  const s = f.make();
  await s.ready;
  let releaseB!: () => void;
  let heldB = false;
  const refreshed: string[] = [];
  f.gateway.refresh = async (id) => {
    refreshed.push(id);
    if (id === "a") throw new Error("host failed for a");
    if (!heldB) { heldB = true; await new Promise<void>(resolve => { releaseB = resolve; }); }
    return structuredClone(f.agents.find(agent => agent.agentId === id) ?? null);
  };
  const release = f.holdList();
  const full = s.observe({ kind: "full" });
  await settle();
  // Two turn ends merge into one plan that refreshes a and b together.
  const merged = [s.observe({ kind: "agent", agentId: "a" }), s.observe({ kind: "agent", agentId: "b" })];
  release();
  await full;
  await assert.rejects(merged[0], /host failed for a/);
  const again = s.observe({ kind: "agent", agentId: "b" });
  await settle();
  assert.deepEqual(refreshed.filter(id => id === "b"), ["b"], "no second read of b while the first is running");
  releaseB();
  await again;
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
    for (let i = 0; i < 100 && !f.sent.includes("b"); i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
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
  const settled = await within(second);
  try {
    assert.notEqual(settled, null, "the second tick resolves without waiting for a");
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
    for (let i = 0; i < 100 && !f.sent.includes("b"); i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
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
  const settled = await within(second);
  try {
    assert.notEqual(settled, null, "the second tick resolves while a's inspection is held");
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
    const tick = s.tick();
    assert.notEqual(await within(tick), null, "the tick does not wait for the manual send");
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
  const early = await within(work.then(() => true));
  release();
  await tick;
  const [changed, missing] = await work;
  assert.equal(early, true, "other conversations resolve while a's host read is held");
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
  await settle();
  // ...when replies of a and b end; their turn-end observations merge.
  f.agents.push(nativeAgent(f, "a"), nativeAgent(f, "b"));
  const merged = [s.observe({ kind: "agent", agentId: "a" }), s.observe({ kind: "agent", agentId: "b" })];
  release();
  await full;
  await assert.rejects(merged[1], /host failed for a/, "the failure is still reported");
  assert.deepEqual(reserved(f), ["b"], "b's finished reply is reserved without waiting for a full scan");
});
