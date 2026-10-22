import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  type Settings,
} from "../shared/settings";
import { createScheduler, DELIVERY_WINDOW_MS } from "./scheduler";
import type { Gateway, Observation, State, StateStore } from "./model";

function fixture(automatic = true) {
  let time = 1_000_000;
  let config: Settings | null = { ...DEFAULT_SETTINGS };
  let state: State = { version: 1, disabled: [], jobs: [] };
  let calls = 0;
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
    read: async () => structuredClone(state),
    write: async (next) => {
      state = structuredClone(next);
    },
  };
  const compact: Gateway["compact"] = async () => {
    calls++;
    return { status: "completed", detail: "same session, completed boundary" };
  };
  const gateway: Gateway = {
    list: async () => structuredClone(agents),
    refresh: async (id) =>
      structuredClone(agents.find((a) => a.agentId === id) ?? null),
    compact,
    ...(automatic ? { automatic: async () => compact("a") } : {}),
  };
  const make = () =>
    createScheduler({
      store,
      gateway,
      settings: async () => config,
      now: () => time,
    });
  return {
    agents,
    gateway,
    store,
    make,
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
    get time() {
      return time;
    },
    advance(ms: number) {
      time += ms;
    },
  };
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
    "completed"
  );
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
    "completed"
  );
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
    assert.equal((await s.compactNow("a", f.agents[0].revision!)).status, "completed");
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
  await f.store.write({
    ...f.state,
    jobs: [{ ...f.state.jobs[0], status: "running", attemptedAt: f.time }],
  });
  s = f.make();
  await s.ready;
  assert.equal(f.state.jobs[0].status, "unknown");
  f.advance(55 * 60_000);
  await s.tick();
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

test("list and policy edits remain responsive during a compaction; only one send host-wide", async () => {
  const f = fixture();
  f.agents.push({ ...f.agents[0], agentId: "b", sessionId: "native-b" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.gateway.compact = async () => {
    started();
    await gate;
    return { status: "completed", detail: "Completed boundary" };
  };
  const s = f.make();
  await s.ready;
  const run = s.compactNow("a", f.agents[0].revision!);
  await start;
  assert.equal((await s.list())[0].status, "running");
  await s.toggle("b", false);
  assert.equal(
    (await s.compactNow("b", f.agents[1].revision!)).status,
    "blocked"
  );
  release();
  await run;
  assert.deepEqual(f.state.disabled, ["b"]);
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
  assert.equal((await scheduler.compactNow('a', f.agents[0].revision!)).status, 'completed');
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
    assert.equal((await s.compactNow("a", f.agents[0].revision!)).status, "completed");
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
