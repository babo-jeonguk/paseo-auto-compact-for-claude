import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded, OBSERVATION_MS } from "./deadline";
import { Refusal, type OperationEvidence, type StoredOperation } from "./model";
import { createGateway, EVIDENCE_POLL_MS } from "./gateway";
import { createObserver, QUERY_RESTARTED_REFUSAL } from "./observer";
import { createOperationWorker } from "./operations";
import { createScheduler } from "./scheduler";
import { DEFAULT_SETTINGS } from "../shared/settings";
import type {
  PluginHandlerContext,
  PluginLifecycleEvents,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";

function fixture(
  items: unknown[],
  outcome: unknown = { kind: "completed" },
  changeSession = false,
  liveItems = items,
  options: Parameters<typeof createGateway>[0] = {}
) {
  const host = createGateway({ timeoutMs: 40, pollMs: 1, ...options });
  let sends = 0;
  let native = "native-a";
  const agent = {
    id: "a",
    provider: "claude",
    cwd: "/work",
    title: null,
    labels: {},
    status: "idle",
    activeTurn: null,
    pendingPermissions: [],
    lastUserMessageAt: new Date(1000).toISOString(),
    lastUsage: { contextWindowUsedTokens: 210_000 },
  };
  const hookAgent = {
    id: "a",
    provider: "claude",
    cwd: "/work",
    title: null,
    parentAgentId: null,
    workspaceId: null,
    background: false,
    metadata: {},
  };
  let liveListener: ((message: unknown) => void) | undefined;
  const ref = {
    timeline: {
      refetch: async () => ({ entries: [] as Array<{ turnId: string | null; item: unknown }> }),
      subscribe: (listener: (message: unknown) => void) => {
        liveListener = listener;
        return Object.assign(() => {}, {
          ready: Promise.resolve(),
          release: async () => {},
        });
      },
    },
    refresh: async () => ({
      agent: { ...agent, persistence: { sessionId: native } },
    }),
    send: async (_text: string, options: { messageId: string }) => {
      sends++;
      host.started({ agent: hookAgent, turnId: "compact-1" });
      liveListener?.({ agentId: "a", event: { type: "timeline", turnId: "compact-1",
        item: { type: "user_message", clientMessageId: options.messageId } } });
      assert.equal(host.ownTurn("a", "compact-1"), true);
      assert.equal(host.ownTurn("a", "normal-2"), false);
      if (changeSession) native = "native-b";
      for (const item of liveItems)
        liveListener?.({
          agentId: "a",
          event: {
            type: "timeline",
            provider: "claude",
            turnId: "compact-1",
            item,
          },
        });
      host.ended({
        agent: hookAgent,
        turnId: "compact-1",
        outcome,
        timeline: items,
      } as PluginLifecycleEvents["agent.turn_ended"]);
    },
  };
  host.attach({
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: { ref: () => ref },
  } as unknown as PluginHandlerContext["paseo"]);
  return Object.assign(host, { ref, sendCount: () => sends,
    setAgent: (patch: Record<string, unknown>) => Object.assign(agent, patch) });
}

test("gateway requires completed manual boundary from command turn and same persistence session", async () => {
  for (const [items, expected] of [
    [[], "unknown"],
    [[{ type: "compaction", status: "loading" }], "unknown"],
    [[{ type: "compaction", status: "completed", trigger: "auto" }], "unknown"],
    [
      [{ type: "compaction", status: "completed", trigger: "manual" }],
      "completed",
    ],
  ] as const) {
    const host = fixture([...items]);
    assert.equal((await host.gateway.compact("a")).status, expected);
  }
  const changed = fixture(
    [{ type: "compaction", status: "completed", trigger: "manual" }],
    { kind: "completed" },
    true
  );
  assert.equal((await changed.gateway.compact("a")).status, "failed");
  const failed = fixture([], {
    kind: "failed",
    error: { message: "fixture failure" },
  });
  assert.equal((await failed.gateway.compact("a")).status, "failed");
  const historicalOnly = fixture(
    [{ type: "compaction", status: "completed", trigger: "manual" }],
    { kind: "completed" },
    false,
    []
  );
  assert.equal(
    (await historicalOnly.gateway.compact("a")).status,
    "unknown",
    "historical compaction in a full lifecycle snapshot must not count as a new boundary"
  );
});

test("hidden background agents are never compaction targets; absent or false background is unchanged", async () => {
  const host = fixture([{ type: "compaction", status: "completed", trigger: "manual" }]);
  for (const background of [undefined, false]) {
    host.setAgent({ background });
    assert.equal((await host.gateway.refresh("a"))!.eligible, true);
    assert.equal((await host.gateway.compact("a")).status, "completed");
    assert.equal(host.sendCount(), background === false ? 2 : 1);
  }
  host.setAgent({ background: true });
  const hidden = (await host.gateway.refresh("a"))!;
  assert.equal(hidden.eligible, false);
  await assert.rejects(host.gateway.compact("a", hidden), Refusal);
  assert.equal(host.sendCount(), 2, "a hidden background agent must not receive /compact");
  host.stop();
});

test("a reservation whose agent later becomes hidden background is skipped instead of dispatched", async () => {
  const host = fixture([]);
  let time = 1_000_000;
  let state: import("./model").State = { version: 1, disabled: [], jobs: [], operations: [] };
  const scheduler = createScheduler({
    store: { read: async () => structuredClone(state), write: async next => { state = structuredClone(next); } },
    gateway: host.gateway,
    settings: async () => ({ ...DEFAULT_SETTINGS }),
    now: () => time,
  });
  await scheduler.ready;
  await scheduler.observedTurn((await host.gateway.refresh("a"))!);
  assert.equal(state.jobs[0].status, "scheduled");
  host.setAgent({ background: true });
  time += 55 * 60_000;
  await scheduler.tick();
  assert.equal(host.sendCount(), 0);
  assert.equal(state.jobs[0].status, "skipped");
  assert.match(state.jobs[0].detail, /no longer eligible/);
  scheduler.stop();
  host.stop();
});

test("completed command ownership is released; stock gateway offers no automatic dispatch", async () => {
  const host = fixture([]);
  const running = host.gateway.compact("a");
  await running;
  assert.equal(host.ownTurn("a", "compact-1"), false);
  assert.equal(host.gateway.automatic, undefined);
  host.stop();
});

type Receipt = { status: 'completed' | 'failed' | 'unknown'; detail: string };
function observer(result: Receipt | null) {
  const operation = { id: 'operation-1', launchId: 'launch', generation: 'generation',
    sessionId: 'native-a', revision: 1, preparedAt: Date.now(), expiresAt: Date.now() + 30000,
    directory: '/unused', status: 'prepared', requireCache: true };
  return {
    read: async () => ({ directory: '/unused', ledger: {
      version: 1 as const, launchId: 'launch', generation: 'generation', sessionId: 'native-a',
      updatedAt: Date.now(), revision: 1, activeTurns: [], pendingInputs: 0, ordinaryEndedAt: 1000,
      ordinaryRevision: 1, cacheDeadline: Date.now() + 300000, compact: null, closed: false,
    } }),
    prepareSession: async (request: never) => request,
    prepare: async (_agent: unknown, _cache: boolean, _expires: number, id: string) => ({ ...operation, id }),
    readiness: async () => null,
    startedHere: (_agentId: string, _launchId: string) => true,
    result: async () => result,
    receipt: async () => result,
    cancel: async () => {},
  } as unknown as NonNullable<Parameters<typeof createGateway>[0]>['observer'];
}

test('automatic public dispatch requires both its own boundary and matching native completion', async () => {
  const boundary = [{ type: 'compaction', status: 'completed', trigger: 'manual' }];
  for (const [receipt, expected] of [
    [null, 'unknown'],
    [{ status: 'completed', detail: 'Native PostCompact' }, 'completed'],
    [{ status: 'unknown', detail: 'Overlapping input' }, 'unknown'],
  ] as const) {
    const host = fixture(boundary, undefined, false, boundary, { observer: observer(receipt), timeoutMs: 1_000 });
    const agent = (await host.gateway.refresh('a'))!;
    assert.equal((await host.gateway.automatic!(agent)).status, expected);
    assert.equal(host.sendCount(), 1);
  }
  // Input after the command (a steered message, say) is not evidence either way.
  const foreign = [...boundary, { type: 'user_message', clientMessageId: 'unrelated' }];
  const host = fixture(boundary, undefined, false, foreign, {
    observer: observer({ status: 'completed', detail: 'Native PostCompact' }), timeoutMs: 1_000,
  });
  assert.equal((await host.gateway.automatic!((await host.gateway.refresh('a'))!)).status, 'completed');
  assert.equal(host.sendCount(), 1);
});

// Another user message seen live after the send, in its own turn or in the
// command's, followed by what Claude and the host report for the command.
interface OverlapOptions { receipt?: Receipt | null; outcome?: unknown; events?: Array<{ turnId: string; item: unknown }>; timeoutMs?: number }
async function overlap({ receipt = { status: 'completed', detail: 'Native PostCompact' },
  outcome = { kind: 'completed' }, events = [], timeoutMs = 1_000 }: OverlapOptions = {}) {
  const host = fixture([], outcome, false, [], { observer: observer(receipt), timeoutMs });
  const send = host.ref.send;
  let emit!: (message: unknown) => void;
  const subscribe = host.ref.timeline.subscribe;
  host.ref.timeline.subscribe = listener => { emit = listener; return subscribe(listener); };
  host.ref.send = async (text, options) => {
    // Every event, the turn's end included, is seen after the command and the steered input.
    const end = host.ended;
    let ending: Parameters<typeof end>[0] | undefined;
    host.ended = event => { ending = event; };
    await send(text, options);
    host.ended = end;
    for (const { turnId, item } of events) emit({ agentId: 'a', event: { type: 'timeline', provider: 'claude', turnId, item } });
    if (ending) end(ending);
  };
  const saved: OperationEvidence[] = [];
  const result = await host.gateway.automatic!((await host.gateway.refresh('a'))!, undefined, {
    id: 'overlap', sendBy: Date.now() + 30_000, checkpoint: async evidence => { saved.push(evidence); }, current: () => true,
  });
  assert.equal(host.sendCount(), 1, '/compact is never sent twice');
  return { result, evidence: saved.at(-1) };
}
const STEERED = { type: 'user_message', clientMessageId: 'steered' };
const OWN_BOUNDARY = { turnId: 'compact-1', item: { type: 'compaction', status: 'completed', trigger: 'manual' } };

test('input after the command does not decide the outcome: Claude and the command turn do', async () => {
  for (const [name, events] of [
    ['steered into the command turn', [{ turnId: 'compact-1', item: STEERED }, OWN_BOUNDARY]],
    ['in its own later turn', [OWN_BOUNDARY, { turnId: 'next-turn', item: STEERED }]],
    ['seen before the boundary', [{ turnId: 'next-turn', item: STEERED }, OWN_BOUNDARY]],
  ] as const) {
    const { result, evidence } = await overlap({ events: [...events] });
    assert.equal(result.status, 'completed', name);
    assert.equal(evidence?.invalidated, false, name);
  }
});

test('with input after the command, a failure Claude or the host reports is still a failure', async () => {
  const events = [{ turnId: 'next-turn', item: STEERED }];
  assert.equal((await overlap({ events, receipt: { status: 'failed', detail: 'Cancelled' } })).result.status, 'failed');
  assert.equal((await overlap({ events, outcome: { kind: 'canceled' } })).result.status, 'failed');
});

test('with input after the command and no completion from Claude, the attempt stays open for reconciliation', async () => {
  const { result, evidence } = await overlap({ events: [{ turnId: 'next-turn', item: STEERED }, OWN_BOUNDARY],
    receipt: null, timeoutMs: 60 });
  assert.equal(result.status, 'unknown');
  assert.equal(evidence?.invalidated, false, 'the evidence stays valid for reconciliation');
});

test('a boundary in any turn but the command\'s own never completes the attempt', async () => {
  const boundary = { type: 'compaction', status: 'completed', trigger: 'manual' };
  const { result } = await overlap({ events: [{ turnId: 'next-turn', item: STEERED }, { turnId: 'next-turn', item: boundary }],
    timeoutMs: 60 });
  assert.equal(result.status, 'unknown');
});

test('last-moment off policy and expired delivery prevent public send', async () => {
  for (const guard of [
    { expiresAt: Date.now() + 30000, allowed: async () => false },
    { expiresAt: 0, allowed: async () => true },
  ]) {
    const host = fixture([], undefined, false, [], { observer: observer(null) });
    // Policy off is a reading; running out of time is not.
    await assert.rejects(host.gateway.automatic!((await host.gateway.refresh('a'))!, guard),
      guard.expiresAt ? Refusal : /Send deadline passed/);
    assert.equal(host.sendCount(), 0);
  }
});

test('before sending, a refusal and any other error are both thrown for the worker to classify', async () => {
  for (const error of [new Refusal('Claude is still working'), new Error('EIO')]) {
    const native = observer(null)!;
    native.prepare = async () => { throw error; };
    const host = fixture([], undefined, false, [], { observer: native });
    const agent = (await host.gateway.refresh('a'))!;
    await assert.rejects(host.gateway.compact('a', agent), error);
    assert.equal(host.sendCount(), 0);
  }
});

test('a second call for a conversation already compacting is a refusal', async () => {
  const host = fixture([{ type: "compaction", status: "completed", trigger: "manual" }]);
  const first = host.gateway.compact('a');
  await assert.rejects(host.gateway.compact('a'), (error: unknown) =>
    error instanceof Refusal && /already running/.test(error.message));
  assert.equal((await first).status, 'completed');
  assert.equal(host.sendCount(), 1);
});

test('Claude admits the compaction for as long as it can be observed, not only until sending must start', async () => {
  const native = observer(null)!;
  const prepare = native.prepare;
  let admitted = 0;
  native.prepare = async (agent, cache, expiresAt, id) => { admitted = expiresAt; return prepare(agent, cache, expiresAt, id); };
  const host = fixture([], undefined, false, [], { observer: native });
  const sendBy = Date.now() + 1_000;
  await host.gateway.automatic!((await host.gateway.refresh('a'))!, { expiresAt: Date.now() + 500, allowed: async () => true },
    { id: 'late-admission', sendBy, checkpoint: async () => {}, current: () => true });
  assert.equal(admitted, sendBy + OBSERVATION_MS);
  assert.equal(host.sendCount(), 1);
});

test("completion evidence is checked every 50 ms after sending", () => {
  assert.equal(EVIDENCE_POLL_MS, 50);
});

test('a send that starts just before its deadline is still observed in full', async () => {
  // A live budget longer than the send deadline, as in production (120 s vs. what is left).
  let time = 1_000_000;
  const host = fixture([{ type: "compaction", status: "completed", trigger: "manual" }],
    undefined, false, undefined, { timeoutMs: 1_000, now: () => time });
  const send = host.ref.send;
  // The send takes past its deadline, so the boundary arrives after it.
  host.ref.send = async (text, options) => { time += 80; return send(text, options); };
  const result = await host.gateway.compact("a", undefined, {
    id: "late-request", sendBy: time + 40, checkpoint: async () => {}, current: () => true,
  });
  assert.equal(result.status, "completed");
  assert.equal(host.sendCount(), 1);
});

test('an unreadable observer is reported on the observation and is a fault before sending', async () => {
  const native = observer(null)!;
  native.read = async () => { throw new Error('Claude observer could not be read'); };
  const host = fixture([], undefined, false, [], { observer: native });
  const agent = (await host.gateway.refresh('a'))!;
  assert.equal(agent.observerUnreadable, true);
  await assert.rejects(host.gateway.compact('a', agent), /could not be read/);
  assert.equal(host.sendCount(), 0);
});

test('a host that reopens stale plugin sessions never sends against an observer from the prior plugin instance', async () => {
  const native = observer(null)!;
  native.startedHere = () => false;
  const host = fixture([], undefined, false, [], { observer: native });
  Object.assign(host.ref, { reload: async () => null });
  assert.equal((await host.gateway.refresh('a'))!.resumeRequired, true);
  await assert.rejects(host.gateway.compact('a', (await host.gateway.refresh('a'))!),
    (error: unknown) => error instanceof Refusal && /resume.*message/i.test(error.message));
  assert.equal(host.sendCount(), 0);
  await assert.rejects(host.gateway.automatic!((await host.gateway.refresh('a'))!),
    (error: unknown) => error instanceof Refusal && /resume.*message/i.test(error.message));
  assert.equal(host.sendCount(), 0);
});

test('a host without session reopening never requires a resume', async () => {
  const native = observer({ status: 'completed', detail: 'Native PostCompact' })!;
  native.startedHere = () => false;
  const host = fixture([{ type: "compaction", status: "completed", trigger: "manual" }], undefined, false, undefined,
    { observer: native });
  const agent = (await host.gateway.refresh('a'))!;
  assert.equal(agent.resumeRequired, undefined);
  assert.equal((await host.gateway.automatic!(agent)).status, 'completed');
});

test('observer ownership is rechecked at the dispatch boundary, in memory, and ends the attempt at once', async () => {
  const native = observer(null)!;
  let ownershipChecks = 0;
  let markerPersisted = false;
  native.startedHere = () => { ownershipChecks++; return !markerPersisted; };
  const host = fixture([], undefined, false, [], { observer: native });
  Object.assign(host.ref, { reload: async () => null });
  const saved: OperationEvidence[] = [];
  const result = await host.gateway.compact('a', (await host.gateway.refresh('a'))!, {
    id: 'ownership-race', sendBy: Date.now() + 30_000,
    checkpoint: async evidence => { saved.push(evidence); markerPersisted ||= evidence.dispatchStartedAt !== undefined; },
    current: () => true,
  });
  assert.equal(result.status, 'unknown');
  assert.match(result.detail, /observer changed.*no automatic retry/i);
  // Two observations before the marker, then the boundary check.
  assert.equal(ownershipChecks, 4);
  assert.equal(saved.at(-1)?.invalidated, true, 'invalidated, so the worker does not wait out the observation');
  assert.equal(host.sendCount(), 0);
});

test('an absent or unreadable observer is not misreported as a session awaiting reload, and reading it never throws', async () => {
  for (const read of [async () => null, async () => { throw new Error('Claude observer could not be read'); }]) {
    const native = observer(null)!;
    native.read = read;
    native.startedHere = () => false;
    native.prepare = async () => { throw new Refusal('Claude observer unavailable'); };
    const host = fixture([], undefined, false, [], { observer: native });
    Object.assign(host.ref, { reload: async () => null });
    const agent = (await host.gateway.refresh('a'))!;
    assert.equal(agent.resumeRequired, undefined);
    await assert.rejects(host.gateway.compact('a', agent),
      (error: unknown) => !/resume.*message/i.test(String(error)));
    assert.equal(host.sendCount(), 0);
  }
});

test('idle pending input is distinguished from an active reply without allowing dispatch', async () => {
  const native = observer(null)!;
  const read = native.read;
  let pendingInputs = 3;
  let activeTurns: string[] = [];
  native.read = async (id) => {
    const current = await read(id);
    return current?.ledger ? { ...current, ledger: { ...current.ledger, pendingInputs, activeTurns,
      ordinaryEndedAt: 1000 } } : current;
  };
  const host = fixture([], undefined, false, [], { observer: native });
  const stuck = (await host.gateway.refresh('a'))!;
  assert.equal(stuck.idle, false);
  assert.equal(stuck.busyReason, 'input');
  assert.equal(stuck.inputIdleSince, 1000);
  await assert.rejects(host.gateway.automatic!(stuck), Refusal);
  assert.equal(host.sendCount(), 0);
  activeTurns = ['ordinary-reply'];
  assert.equal((await host.gateway.refresh('a'))!.inputIdleSince, null);
  activeTurns = [];
  pendingInputs = 0;
  assert.equal((await host.gateway.refresh('a'))!.idle, true);
  assert.equal((await host.gateway.refresh('a'))!.inputIdleSince, null);
  host.stop();
});


test("every external gateway wait is bounded, including send and release", async () => {
  for (const stalled of ["send", "subscribe", "refresh", "release"] as const) {
    const host = fixture([{ type: "compaction", status: "completed", trigger: "manual" }],
      undefined, false, undefined, { timeoutMs: 50, dispatchTimeoutMs: 5, cleanupTimeoutMs: 5 });
    const never = () => new Promise<never>(() => {});
    if (stalled === "send") host.ref.send = never;
    if (stalled === "refresh") host.ref.refresh = never;
    if (stalled === "subscribe" || stalled === "release") {
      const subscribe = host.ref.timeline.subscribe;
      host.ref.timeline.subscribe = listener => {
        const result = subscribe(listener);
        if (stalled === "subscribe") result.ready = never();
        else result.release = never;
        return result;
      };
    }
    // A wait that expires before sending is a fault for the worker to retry.
    if (stalled === "subscribe" || stalled === "refresh") {
      await assert.rejects(bounded(host.gateway.compact("a", undefined, { id: "stalled", sendBy: Date.now() + 50,
        checkpoint: async () => {}, current: () => true }), 2_000), /deadline/i, stalled);
      assert.equal(host.sendCount(), 0, stalled);
      continue;
    }
    const result = await bounded(host.gateway.compact("a"), 2_000);
    assert.equal(result.status, stalled === "release" ? "completed" : "unknown", stalled);
    assert.equal(host.ownTurn("a", "compact-1"), false);
    host.stop();
  }
});

test("stable identity and durable send marker precede provider dispatch", async () => {
  const host = fixture([{ type: "compaction", status: "completed", trigger: "manual" }]);
  const checkpoints: OperationEvidence[] = [];
  const send = host.ref.send;
  host.ref.send = async (text, options) => {
    assert.equal(options.messageId, "caller-request");
    assert(checkpoints.at(-1)?.dispatchStartedAt);
    return send(text, options);
  };
  const result = await host.gateway.compact("a", undefined, {
    id: "caller-request", sendBy: Date.now() + 1000,
    checkpoint: async evidence => { checkpoints.push(evidence); }, current: () => true,
  });
  assert.equal(result.status, "completed");
  assert.equal(checkpoints.at(-1)?.boundary, true);
  assert.equal(checkpoints.at(-1)?.turnId, "compact-1");
});

test("failed marker persistence never sends and late send rejection is consumed", async () => {
  const host = fixture([]);
  // A fault before sending is the worker's to retry, so it is thrown, not an outcome.
  await assert.rejects(host.gateway.compact("a", undefined, {
    id: "caller-request", sendBy: Date.now() + 1000,
    checkpoint: async () => { throw new Error("disk full"); }, current: () => true,
  }), /disk full/);
  assert.equal(host.sendCount(), 0);
  let reject!: (error: Error) => void;
  host.ref.send = async () => new Promise<never>((_resolve, fail) => { reject = fail; });
  assert.equal((await host.gateway.compact("a")).status, "unknown");
  reject(new Error("late rejection"));
  await new Promise<void>(resolve => setImmediate(resolve));
});

test("recovery requires both the native receipt and the exact message's command boundary", async () => {
  const native = observer({ status: "completed", detail: "receipt" })!;
  const host = fixture([], undefined, false, [], { observer: native });
  const operation: StoredOperation = {
    id: "caller-request", agentId: "a", revision: "rev", target: { sessionId: "native-a", activityKey: null },
    kind: "manual", state: "observing", createdAt: 1, updatedAt: 1, result: null, inputFingerprint: null,
    evidence: { dispatchStartedAt: 1, native: { id: "caller-request", launchId: "launch", generation: "gen",
      sessionId: "native-a", revision: 1 } },
  };
  assert.equal(await host.gateway.inspect!(operation), null, "native completion alone is insufficient");
  host.ref.timeline.refetch = async () => ({ entries: [
    { turnId: "our-turn", item: { type: "user_message", clientMessageId: operation.id } },
    { turnId: "foreign-turn", item: { type: "compaction", status: "completed", trigger: "manual" } },
  ] });
  assert.equal(await host.gateway.inspect!(operation), null);
  host.ref.timeline.refetch = async () => ({ entries: [
    { turnId: "our-turn", item: { type: "user_message", clientMessageId: operation.id } },
    { turnId: "our-turn", item: { type: "compaction", status: "completed", trigger: "manual" } },
  ] });
  assert.equal((await host.gateway.inspect!(operation))?.status, "completed");
  host.ref.timeline.refetch = async () => ({ entries: [
    { turnId: "our-turn", item: { type: "user_message", clientMessageId: operation.id } },
    { turnId: "next-turn", item: { type: "user_message", clientMessageId: "steered" } },
    { turnId: "our-turn", item: { type: "compaction", status: "completed", trigger: "manual" } },
  ] });
  assert.equal((await host.gateway.inspect!(operation))?.status, "completed", "later input is not evidence");
  // A record stored as invalidated by an earlier release keeps its answer.
  operation.evidence!.invalidated = true;
  assert.equal((await host.gateway.inspect!(operation))?.status, "unknown");
  operation.evidence!.invalidated = false;
  // Observation runs a fixed time from the marker; a receipt after that never counts.
  native.receipt = async () => ({ status: "completed", detail: "late receipt", observedAt: 1 + OBSERVATION_MS + 1 });
  assert.equal(await host.gateway.inspect!(operation), null, "late completion cannot extend the observation deadline");
});

test('native activity identity survives compaction without restoring its scheduling window', async () => {
  const native = observer(null)!;
  const initial = (await native.read('a'))!;
  let ledger = initial.ledger!;
  native.read = async () => ({ directory: initial.directory, ledger });
  const host = fixture([], undefined, false, [], { observer: native });
  const before = await host.gateway.refresh('a');
  assert(before?.activityKey);
  for (const status of ['running', 'completed', 'failed', 'unknown'] as const) {
    ledger = { ...ledger, ordinaryRevision: null, ordinaryEndedAt: null, cacheDeadline: null,
      compact: { id: 'operation', revision: 1, status } };
    const after = await host.gateway.refresh('a');
    assert.equal(after?.activityKey, before.activityKey);
    assert.equal(after?.observedEndedAt, null, 'compaction cannot create an ordinary reservation');
  }
  ledger = { ...ledger, revision: 2 };
  assert.equal((await host.gateway.refresh('a'))?.activityKey, null, 'old compact evidence cannot name new input');
  ledger = { ...ledger, ordinaryRevision: 2, ordinaryEndedAt: 2000 };
  assert.notEqual((await host.gateway.refresh('a'))?.activityKey, before.activityKey);
  ledger = { ...ledger, sessionId: 'another-session' };
  assert.equal((await host.gateway.refresh('a'))?.activityKey, null);
  host.stop();
});

// A host directory of many agents, paged like Paseo's agent list, with an
// observer that records which agents' native ledgers were read. A `slow`
// agent's ledger read does not end; a `broken` agent's host reference throws.
// `holdRead` and `holdPage` may delay or fail one ledger read or listing page.
function directory(pageSize = 2, { slow = [] as string[], broken = [] as string[],
  holdRead = (_id: string): Promise<void> | void => {},
  holdPage = (_start: number): Promise<void> | void => {} } = {}) {
  const base = {
    provider: "claude", cwd: "/work", title: null, labels: {} as Record<string, string>, status: "idle",
    activeTurn: null, pendingPermissions: [], lastUserMessageAt: new Date(1000).toISOString(),
    lastUsage: { contextWindowUsedTokens: 210_000 },
  };
  const agents = [
    { ...base, id: "a" },
    { ...base, id: "b" },
    { ...base, id: "c" },
    { ...base, id: "archived", archivedAt: new Date(2000).toISOString() },
    { ...base, id: "internal", internal: true },
    { ...base, id: "child", labels: { "paseo.parent-agent-id": "a" } },
    { ...base, id: "unavailable", providerUnavailable: true },
    { ...base, id: "closed", status: "closed" },
    { ...base, id: "codex", provider: "codex" },
  ].map(agent => ({ ...agent, persistence: { sessionId: `native-${agent.id}` } }));
  const reads: string[] = [];
  let listCalls = 0;
  const native = observer(null)!;
  const read = native.read;
  native.read = async (id: string) => {
    reads.push(id);
    if (slow.includes(id)) await new Promise(() => {});
    await holdRead(id);
    const current = await read(id);
    return current?.ledger ? { ...current, ledger: { ...current.ledger, sessionId: `native-${id}` } } : current;
  };
  const host = createGateway({ observer: native });
  host.attach({
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async (options: { page?: { limit?: number; cursor?: string } }) => {
        listCalls++;
        const start = Number(options.page?.cursor ?? 0);
        await holdPage(start);
        const end = start + Math.min(pageSize, options.page?.limit ?? pageSize);
        return {
          entries: agents.slice(start, end).map(agent => ({ agent })),
          pageInfo: { hasMore: end < agents.length, nextCursor: end < agents.length ? String(end) : null },
        };
      },
      ref: (id: string) => {
        if (broken.includes(id)) throw new Error(`host failed for ${id}`);
        return { refresh: async () => {
          const agent = agents.find(entry => entry.id === id);
          return agent ? { agent } : null;
        } };
      },
    },
  } as unknown as PluginHandlerContext["paseo"]);
  return { host, reads, get listCalls() { return listCalls; } };
}
const INELIGIBLE = ["archived", "internal", "child", "unavailable", "closed", "codex"];

test("the full list still observes every agent, but reads native ledgers only for eligible Claude agents", async () => {
  const { host, reads } = directory();
  const listed: Promise<import("./model").Observation>[] = [];
  await host.gateway.list((observation) => { listed.push(observation); });
  const observations = await Promise.all(listed);
  assert.deepEqual(observations.map(agent => agent.agentId),
    ["a", "b", "c", ...INELIGIBLE], "every listed agent is still reported");
  assert.deepEqual(observations.filter(agent => agent.eligible).map(agent => agent.agentId), ["a", "b", "c"]);
  for (const agent of observations.filter(agent => agent.eligible)) {
    assert.ok(agent.activityKey, `${agent.agentId} keeps its native activity identity`);
    assert.equal(agent.observedEndedAt, 1000);
    assert.equal(agent.idle, true);
  }
  assert.deepEqual([...reads].sort(), ["a", "b", "c"]);
  for (const agent of observations.filter(agent => !agent.eligible)) {
    assert.equal(agent.activityKey ?? null, null, `${agent.agentId} has no native activity to schedule`);
    assert.equal(agent.observedEndedAt ?? null, null);
  }
  host.stop();
});

test("each listed agent's observation settles on its own, so a slow or failing one hides no other", async () => {
  const dir = directory(2, { slow: ["b"], broken: ["c"] }), { host } = dir;
  const listed: Promise<import("./model").Observation>[] = [];
  await host.gateway.list((observation) => { listed.push(observation); });
  assert.equal(dir.listCalls, Math.ceil((3 + INELIGIBLE.length) / 2), "every page is listed without waiting for b");
  assert.equal(listed.length, 3 + INELIGIBLE.length, "b is still listed");
  // Everything but b settles although b's read never ends.
  const results = await Promise.allSettled(listed.filter((_, index) => index !== 1));
  const fulfilled = results.flatMap(result => result.status === "fulfilled" ? [result.value.agentId] : []);
  assert.deepEqual(fulfilled, ["a", ...INELIGIBLE], "every other observation is returned");
  const failures = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  assert.deepEqual(failures, ["Error: host failed for c"], "c's failure is returned with them");
  host.stop();
});

// A scheduler over the real gateway, with state kept in memory. `listing()` is
// the scheduler's latest agent listing, so a test can wait for paging to end.
function directoryScheduler(host: ReturnType<typeof directory>["host"]) {
  let state: import("./model").State = { version: 1, disabled: [], jobs: [], operations: [] };
  let listing: Promise<void> | undefined;
  const scheduler = createScheduler({
    store: { read: async () => structuredClone(state), write: async next => { state = structuredClone(next); } },
    gateway: { ...host.gateway, list: observe => (listing = host.gateway.list(observe)) },
    settings: async () => ({ ...DEFAULT_SETTINGS }),
    now: () => 1_000_000,
  });
  return { scheduler, listing: () => listing,
    reserved: () => state.jobs.filter(job => job.status === "scheduled").map(job => job.agentId).sort() };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("a scan whose later listing page fails stays single-flight until reads started on earlier pages end", async () => {
  let releaseA!: () => void;
  const heldA = new Promise<void>(resolve => { releaseA = resolve; });
  const dir = directory(1, {
    holdRead: id => id === "a" ? heldA : undefined,
    holdPage: start => { if (start === 1) throw new Error("page failed"); },
  });
  const { scheduler } = directoryScheduler(dir.host);
  try {
    await scheduler.ready;
    await assert.rejects(scheduler.observe({ kind: "full" }), /page failed/);
    const next = scheduler.observe({ kind: "agent", agentId: "b" });
    await turn();
    assert.deepEqual(dir.reads, ["a"], "b is not read while a's read from the failed scan still runs");
    releaseA();
    await next;
    assert.deepEqual(dir.reads, ["a", "b"]);
  } finally {
    releaseA();
    scheduler.stop();
    dir.host.stop();
  }
});

test("a listed conversation's read is bounded from when it starts, not from when paging ends", async () => {
  let releasePage!: () => void;
  const page = new Promise<void>(resolve => { releasePage = resolve; });
  let releaseA!: () => void;
  const heldA = new Promise<void>(resolve => { releaseA = resolve; });
  let startedA!: () => void;
  const readingA = new Promise<void>(resolve => { startedA = resolve; });
  const dir = directory(1, {
    holdRead: id => { if (id === "a") { startedA(); return heldA; } },
    holdPage: start => start === 1 ? page : undefined,
  });
  const { scheduler, listing, reserved } = directoryScheduler(dir.host);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await scheduler.ready;
    let settled: unknown = "pending";
    // Read through a call: an assertion must not narrow it for later checks.
    const outcome = () => settled;
    const scan = scheduler.observe({ kind: "full" });
    scan.then(() => { settled = "resolved"; }, error => { settled = error; });
    await readingA;
    assert.deepEqual(dir.reads, ["a"], "a's read starts with the first page");
    // Paging takes four of the five seconds; a's read never ends.
    mock.timers.tick(4_000);
    releasePage();
    await listing();
    assert.equal(outcome(), "pending", "a's read is not timed out when paging ends");
    mock.timers.tick(1_000);
    for (let step = 0; step < 20 && outcome() === "pending"; step++) await turn();
    assert.ok(outcome() instanceof Error, "a's read timed out five seconds after it started");
    assert.deepEqual(reserved(), ["b", "c"], "every other listed reply is still reserved");
  } finally {
    releasePage();
    releaseA();
    mock.timers.reset();
    scheduler.stop();
    dir.host.stop();
  }
});

test("refreshing an ineligible agent does not read its ledger; an eligible one still does", async () => {
  const { host, reads } = directory();
  for (const id of INELIGIBLE) {
    const agent = await host.gateway.refresh(id);
    assert.equal(agent?.eligible, false, id);
  }
  assert.equal(reads.length, 0);
  assert.ok((await host.gateway.refresh("a"))?.activityKey);
  assert.deepEqual(reads, ["a"]);
  host.stop();
});

// A /compact whose live timeline view is lost right after the send: the host
// emits `lost`, then `live` items. `history` is what a timeline refetch returns,
// the command's own entry first unless the test says otherwise; `lose` emits
// another lost view while that read is in flight. `reads` counts the refetches.
test("recovery completes from stored boundary evidence when history no longer pins the command", async () => {
  const host = fixture([], undefined, false, [], { observer: observer({ status: "completed", detail: "receipt" }) });
  const operation: StoredOperation = {
    id: "stored", agentId: "a", revision: "rev", target: { sessionId: "native-a", activityKey: null },
    kind: "manual", state: "observing", createdAt: 1, updatedAt: 1, result: null, inputFingerprint: null,
    evidence: { dispatchStartedAt: 1, turnId: "our-turn", boundary: true, native: { id: "stored", launchId: "launch",
      generation: "gen", sessionId: "native-a", revision: 1 } },
  };
  // After a daemon restart the restored rows carry neither message nor turn IDs.
  host.ref.timeline.refetch = async () => ({ entries: [
    { turnId: null, item: { type: "user_message", text: "/compact" } },
    { turnId: null, item: { type: "user_message", clientMessageId: "steered" } },
  ] });
  assert.equal((await host.gateway.inspect!(operation))?.status, "completed");
});

test("a live view lost while completion is verified is proved again from history", async () => {
  const host = fixture([], undefined, false, [BOUNDARY_ITEM], { observer: observer({ status: "completed", detail: "Native PostCompact" }) });
  let emit!: (message: unknown) => void;
  const subscribe = host.ref.timeline.subscribe;
  host.ref.timeline.subscribe = listener => { emit = listener; return subscribe(listener); };
  const send = host.ref.send;
  let sent = false, lost = false;
  host.ref.send = async (text, options) => { await send(text, options); sent = true; };
  const refresh = host.ref.refresh;
  // The view is lost once, during the first session check after the send.
  host.ref.refresh = async () => {
    const current = await refresh();
    if (sent && !lost) { lost = true; emit({ agentId: "a", event: { type: "replacement", epoch: "epoch-2" } }); }
    return current;
  };
  let reads = 0;
  host.ref.timeline.refetch = async () => { reads++; return { entries: [command("verify"), { turnId: "compact-1", item: BOUNDARY_ITEM }] }; };
  const result = await host.gateway.automatic!((await refresh().then(() => host.gateway.refresh("a")))!, undefined, {
    id: "verify", sendBy: Date.now() + 30_000, checkpoint: async () => {}, current: () => true,
  });
  assert.equal(result.status, "completed");
  assert.ok(reads > 0, "the proof seen before the loss was not trusted on its own");
  assert.equal(host.sendCount(), 1);
});

const BOUNDARY_ITEM = { type: "compaction", status: "completed", trigger: "manual" };
const LOST_VIEW = ["subscription_restored", "replacement", "error"] as const;
type HistoryEntry = { turnId: string | null; item: unknown };
const BOUNDARY = { type: "compaction", status: "completed", trigger: "manual" };
interface LostViewOptions {
  live?: readonly unknown[]; before?: readonly unknown[];
  history?: (id: string, lose: () => void) => HistoryEntry[];
  receipt?: { status: "completed" | "unknown"; detail: string } | null;
  timeoutMs?: number; now?: () => number;
}
async function lostView(lost: typeof LOST_VIEW[number], { live = [], before = [],
  history = (id: string) => [command(id), { turnId: "compact-1", item: BOUNDARY }],
  receipt = { status: "completed", detail: "Native PostCompact" },
  timeoutMs = 1_000, now = Date.now }: LostViewOptions = {}) {
  const host = fixture([], undefined, false, [...before], { observer: observer(receipt), timeoutMs, now });
  const send = host.ref.send;
  let emit!: (message: unknown) => void;
  const subscribe = host.ref.timeline.subscribe;
  host.ref.timeline.subscribe = listener => { emit = listener; return subscribe(listener); };
  const lose = () => emit({ agentId: "a", event: lost === "replacement" ? { type: lost, epoch: "epoch-2" }
    : lost === "error" ? { type: lost, error: "transport closed" } : { type: lost }, subscriptionId: "s" });
  host.ref.send = async (text, options) => {
    await send(text, options);
    lose();
    for (const item of live) emit({ agentId: "a", event: { type: "timeline", provider: "claude", turnId: "compact-1", item } });
  };
  let reads = 0;
  host.ref.timeline.refetch = async () => { reads++; return { entries: history(id, lose) }; };
  const id = `lost-${lost}`;
  const saved: OperationEvidence[] = [];
  const result = await host.gateway.automatic!((await host.gateway.refresh("a"))!, undefined, {
    id, sendBy: now() + 30_000, checkpoint: async evidence => { saved.push(evidence); }, current: () => true,
  });
  assert.equal(host.sendCount(), 1, "/compact is never sent twice");
  return { result, evidence: saved.at(-1), reads };
}
const command = (id: string) => ({ turnId: "compact-1", item: { type: "user_message", clientMessageId: id } });

test("a lost live view is not a conversation change: completion is read from the receipt and pinned history", async () => {
  for (const lost of LOST_VIEW) {
    const { result, evidence } = await lostView(lost, { live: [BOUNDARY] });
    assert.equal(result.status, "completed", lost);
    assert.equal(evidence?.invalidated, false, lost);
  }
});

test("after a lost live view, a boundary only history shows is enough", async () => {
  for (const lost of LOST_VIEW) {
    const { result, evidence } = await lostView(lost);
    assert.equal(result.status, "completed", lost);
    assert.equal(evidence?.invalidated, false, lost);
    assert.equal(evidence?.turnId, "compact-1", lost);
  }
});

test("after a lost live view, another user message after the command in history is not evidence", async () => {
  const other = { turnId: "next-turn", item: { type: "user_message", clientMessageId: "someone-else" } };
  const boundary = { turnId: "compact-1", item: BOUNDARY };
  for (const lost of LOST_VIEW) {
    for (const history of [(id: string) => [command(id), other, boundary], (id: string) => [command(id), boundary, other]]) {
      const { result, evidence } = await lostView(lost, { live: [BOUNDARY], history });
      assert.equal(result.status, "completed", lost);
      assert.equal(evidence?.invalidated, false, lost);
    }
  }
});

test("after a lost live view, completion still needs the native receipt and the command's own boundary in history", async () => {
  const foreign = (id: string) => [command(id), { turnId: "other-turn", item: BOUNDARY }];
  // A page without the command is not proof that it was never delivered.
  const missing = () => [{ turnId: "compact-1", item: BOUNDARY }];
  for (const lost of LOST_VIEW) {
    for (const [name, options] of [
      ["no native completion", { receipt: null }],
      ["boundary in another turn", { history: foreign }],
      ["command missing from the page", { history: missing }],
    ] as const) {
      const { result, evidence, reads } = await lostView(lost, { live: [BOUNDARY], timeoutMs: 60, ...options });
      assert.equal(result.status, "unknown", `${lost}: ${name}`);
      // History is only worth reading once Claude reports completion; when it
      // does, the outcome must come from having read it, not from the deadline.
      assert.equal(reads > 0, options !== undefined && !("receipt" in options), `${lost}: ${name} reads history`);
      assert.equal(evidence?.invalidated, false, `${lost}: ${name} leaves the evidence for reconciliation`);
      assert.notEqual(evidence?.boundary, true, `${lost}: ${name} records no boundary`);
    }
  }
});

test("a history page read across another lost live view proves nothing, not even a change", async () => {
  const other = { turnId: "next-turn", item: { type: "user_message", clientMessageId: "someone-else" } };
  const boundary = { turnId: "compact-1", item: BOUNDARY };
  for (const lost of LOST_VIEW) {
    // The first page is read while the view is lost again, so it may belong to
    // the replaced epoch; the page read after it shows the real history.
    let offset = 0, first = true;
    const history = (id: string, lose: () => void) => {
      if (!first) return [command(id), boundary];
      first = false;
      lose();
      offset += 1_000; // the next poll may read history again
      return [command(id), other, boundary];
    };
    const { result, evidence, reads } = await lostView(lost, { history, timeoutMs: 5_000, now: () => Date.now() + offset });
    assert.equal(reads, 2, lost);
    assert.equal(result.status, "completed", lost);
    assert.equal(evidence?.invalidated, false, lost);
  }
});

// A wait that should end within a few polls of 1 ms is a failure after this.
const POLL_WAIT_BOUND_MS = 5_000;
// Counts an attempt's polls and wakes a waiting test on each one, so the test
// waits for the poll it needs instead of sleeping. It fails rather than hangs
// when the attempt ends, or stops reaching the counted call, while the test
// still expects it to poll.
function pollSignal() {
  let count = 0;
  let wake: (() => void) | undefined;
  return {
    get count() { return count; },
    poll() { count++; wake?.(); },
    async until(done: () => boolean, attempt: Promise<unknown>, why: string) {
      const ended = attempt.then(() => { throw new Error(why); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${why} (no expected poll within ${POLL_WAIT_BOUND_MS} ms)`)),
          POLL_WAIT_BOUND_MS);
      });
      ended.catch(() => {}); // only the race below observes these
      bound.catch(() => {});
      try {
        while (!done()) await Promise.race([new Promise<void>(resolve => { wake = resolve; }), ended, bound]);
      } finally { clearTimeout(timer); }
    },
  };
}

test("after a lost live view, history is read at most once a second while completion is awaited", async () => {
  let time = Date.now();
  const native = observer({ status: "completed", detail: "Native PostCompact" })!;
  const polls = pollSignal();
  const receipt = native.receipt;
  native.receipt = (...args) => { polls.poll(); return receipt(...args); };
  const host = fixture([], undefined, false, [], { observer: native, timeoutMs: 120_000, now: () => time });
  const send = host.ref.send;
  let emit!: (message: unknown) => void;
  const subscribe = host.ref.timeline.subscribe;
  host.ref.timeline.subscribe = listener => { emit = listener; return subscribe(listener); };
  host.ref.send = async (text, options) => {
    await send(text, options);
    emit({ agentId: "a", event: { type: "subscription_restored" }, subscriptionId: "s" });
  };
  let reads = 0;
  // The page never shows the boundary, so the attempt keeps polling.
  host.ref.timeline.refetch = async () => { reads++; return { entries: [command("interval")] }; };
  const attempt = host.gateway.automatic!((await host.gateway.refresh("a"))!, undefined, {
    id: "interval", sendBy: time + 30_000, checkpoint: async () => {}, current: () => true,
  });
  const until = (done: () => boolean) => polls.until(done, attempt, "the attempt stopped polling");
  const pollsAfter = (count: number) => { const target = polls.count + count; return until(() => polls.count >= target); };
  try {
    await until(() => reads >= 1);
    await pollsAfter(5);
    assert.equal(reads, 1, "no second read within the same instant");
    time += 999;
    await pollsAfter(5);
    assert.equal(reads, 1, "no second read before a second has passed");
    time += 1;
    await until(() => reads >= 2);
    assert.equal(reads, 2, "one more read once a second has passed");
  } finally {
    time += 120_000; // past the live deadline, so the attempt ends even if an assertion failed
    assert.equal((await attempt).status, "unknown");
  }
  assert.equal(host.sendCount(), 1);
});

test("another user message seen live, before or after a lost live view, does not end the attempt", async () => {
  const message = { type: "user_message", clientMessageId: "someone-else" };
  for (const lost of LOST_VIEW) {
    for (const [name, options] of [["before", { before: [message] }], ["after", { live: [message] }]] as const) {
      const { result, evidence } = await lostView(lost, { ...options });
      assert.equal(result.status, "completed", `${lost}: ${name}`);
      assert.equal(evidence?.invalidated, false, `${lost}: ${name}`);
    }
  }
});

test("an attempt that ends unknown after a lost live view stays open for reconciliation", async () => {
  const host = fixture([], undefined, false, [], { observer: observer(null), timeoutMs: 40 });
  const send = host.ref.send;
  let emit!: (message: unknown) => void;
  const subscribe = host.ref.timeline.subscribe;
  host.ref.timeline.subscribe = listener => { emit = listener; return subscribe(listener); };
  host.ref.send = async (text, options) => {
    await send(text, options);
    emit({ agentId: "a", event: { type: "replacement", epoch: "epoch-2" } });
  };
  const agent = (await host.gateway.refresh("a"))!;
  const time = Date.now();
  let state: import("./model").State = { version: 1, disabled: [], jobs: [], operations: [{
    id: "lost-view", agentId: "a", revision: agent.revision!, target: { sessionId: agent.sessionId, activityKey: agent.activityKey ?? null },
    kind: "manual", state: "requested", createdAt: time, updatedAt: time, result: null, inputFingerprint: "lost-view",
    sendBy: time + 10_000, attempt: 0 }] };
  let tail: Promise<unknown> = Promise.resolve();
  const errors: unknown[] = [];
  const worker = createOperationWorker({
    store: { read: async () => structuredClone(state), write: async next => { state = structuredClone(next); } },
    update: change => {
      const result = tail.then(() => { const next = structuredClone(state); const value = change(next); state = next; return value; });
      tail = result.catch(() => {});
      return result;
    },
    gateway: host.gateway, settings: async () => ({ ...DEFAULT_SETTINGS }), now: Date.now, onError: error => errors.push(error),
  });
  await worker.reconcile();
  worker.stop();
  host.stop();
  assert.deepEqual(errors, []);
  assert.equal(host.sendCount(), 1);
  assert.equal(state.operations[0].state, "observing", "left for reconciliation, not finished");
  assert.equal(state.operations[0].result, null);
  assert.equal(state.operations[0].evidence?.invalidated, false);
});

async function realObserverFixture(now = () => Date.now()) {
  const home = await mkdtemp(join(tmpdir(), "compact-gateway-restart-"));
  const native = createObserver({ home, now });
  // Include Paseo 0.14+ session-open fields so this compiles across SDK 0.12–0.16+.
  await native.prepareSession({
    agentId: "a", workspaceId: "w", provider: "claude", purpose: "interactive", reason: "create",
    cwd: home, title: "Conversation", labels: {}, metadata: {}, background: false, tools: [], mcpServers: {}, env: {},
  } as PluginSessionOpenRequest, true);
  const parent = join(home, "plugin-data/auto-compact-for-claude/observers",
    (await readdir(join(home, "plugin-data/auto-compact-for-claude/observers")))[0]);
  const manifest = JSON.parse(await readFile(join(parent, "current.json"), "utf8"));
  const directory = join(parent, manifest.launchId);
  const ledger = {
    version: 1, launchId: manifest.launchId, generation: "gen-1", sessionId: "native-a",
    updatedAt: now(), revision: 2, activeTurns: [] as string[], pendingInputs: 0,
    ordinaryEndedAt: now(), ordinaryRevision: 2, clockEpoch: 0, transcriptPath: null,
    cacheRequest: { startedAt: now(), model: "claude-sonnet-4-6", policy: { ttl: "1h", source: "settings" } },
    compact: null as Record<string, unknown> | null, closed: false,
  };
  const saveLedger = () => writeFile(join(directory, "ledger.json"), JSON.stringify({ ...ledger, updatedAt: now() }));
  await saveLedger();
  const readRequest = () => readFile(join(directory, "request.json"), "utf8").then(text => JSON.parse(text));
  const writeReceipt = (id: string, value: Record<string, unknown>) =>
    writeFile(join(parent, "receipts", `${encodeURIComponent(id)}.json`), JSON.stringify(value));
  return {
    home, native, parent, directory, launchId: manifest.launchId as string, ledger,
    saveLedger, readRequest, writeReceipt,
    close: () => rm(home, { recursive: true, force: true }),
  };
}

test("live observation reports a confirmed query-restart refusal promptly for both Compact now and automatic compaction", async () => {
  for (const kind of ["manual", "automatic"] as const) {
    const time = 1_000_000;
    const obs = await realObserverFixture(() => time);
    try {
      const host = fixture([], undefined, false, [], {
        observer: obs.native, now: () => time, timeoutMs: 120_000, pollMs: 1,
      });
      const send = host.ref.send;
      let sawGenerationChange!: () => void;
      const generationChanged = new Promise<void>(resolve => { sawGenerationChange = resolve; });
      const originalResult = obs.native.result;
      let pollsOnNewGeneration = 0;
      obs.native.result = async (agentId, op) => {
        const res = await originalResult(agentId, op);
        if (obs.ledger.generation === "gen-2" && ++pollsOnNewGeneration === 2) sawGenerationChange();
        return res;
      };
      host.ref.send = async (text, options) => {
        await send(text, options);
        // First, the restarted query starts with a new generation before /compact is admitted.
        obs.ledger.generation = "gen-2";
        obs.ledger.revision = 0;
        obs.ledger.compact = null;
        await obs.saveLedger();
        // Wait until live observation has polled across the generation change without cancelling request.json.
        void generationChanged.then(async () => {
          const req = await obs.readRequest();
          assert.equal(req.status, "prepared", `${kind}: live observation must not cancel request.json on generation change alone`);
          const prepared = { launchId: req.launchId, generation: req.generation, sessionId: req.sessionId, revision: req.revision };
          const record = {
            id: req.id, launchId: obs.launchId, generation: "gen-2", sessionId: "native-a", revision: 0,
            status: "failed", reason: "Claude query restarted before compaction ran", observedAt: time + 50,
            refusal: QUERY_RESTARTED_REFUSAL, prepared,
          };
          await obs.writeReceipt(req.id, record);
          obs.ledger.compact = {
            id: req.id, revision: 0, status: "failed", reason: record.reason,
            refusal: QUERY_RESTARTED_REFUSAL, prepared,
          };
          await obs.saveLedger();
        });
      };
      const agent = (await host.gateway.refresh("a"))!;
      const execution = { id: `op-${kind}`, sendBy: time + 30_000, checkpoint: async () => {}, current: () => true };
      const outcome = kind === "automatic"
        ? await host.gateway.automatic!(agent, { expiresAt: time + 30_000, allowed: async () => true }, execution)
        : await host.gateway.compact("a", agent, execution);
      assert.equal(outcome.status, "failed", kind);
      assert.match(outcome.detail, /query restarted/i, kind);
      assert.equal(host.sendCount(), 1, kind);
      assert.equal((await obs.readRequest()).status, "settled", `${kind}: consumed refusal is settled on cleanup`);
      host.stop();
    } finally { await obs.close(); }
  }
});

test("a generation change without a matching refusal stays pending until the observation deadline", async () => {
  let time = 1_000_000;
  const obs = await realObserverFixture(() => time);
  const host = fixture([], undefined, false, [], {
    observer: obs.native, now: () => time, timeoutMs: 120_000, pollMs: 1,
  });
  let attempt: Promise<import("./model").CompactOutcome> | undefined;
  try {
    const send = host.ref.send;
    const originalResult = obs.native.result;
    const pollsOnNewGeneration = pollSignal();
    obs.native.result = async (agentId, op) => {
      const res = await originalResult(agentId, op);
      if (obs.ledger.generation === "gen-2") pollsOnNewGeneration.poll();
      return res;
    };
    host.ref.send = async (text, options) => {
      await send(text, options);
      obs.ledger.generation = "gen-2";
      obs.ledger.revision = 0;
      obs.ledger.compact = null;
      await obs.saveLedger();
    };
    const agent = (await host.gateway.refresh("a"))!;
    let settled = false;
    attempt = host.gateway.compact("a", agent, {
      id: "gen-only", sendBy: time + 30_000, checkpoint: async () => {}, current: () => true,
    });
    void attempt.finally(() => { settled = true; });
    const until = (done: () => boolean) =>
      pollsOnNewGeneration.until(done, attempt!, "the attempt stopped polling before the deadline");
    await until(() => pollsOnNewGeneration.count >= 3);
    assert.equal(settled, false, "a bare generation change must not exit live observation early");
    assert.equal((await obs.readRequest()).status, "prepared");
    time += 59_000;
    await obs.saveLedger();
    const afterChange = pollsOnNewGeneration.count;
    await until(() => pollsOnNewGeneration.count >= afterChange + 2);
    assert.equal(settled, false, "execution must stay pending before the live deadline");
    assert.equal((await obs.readRequest()).status, "prepared");
    time += 61_000;
    const outcome = await attempt;
    assert.equal(outcome.status, "unknown");
    assert.equal(host.sendCount(), 1);
    assert.equal((await obs.readRequest()).status, "cancelled");
  } finally {
    time += 120_000;
    await attempt?.catch(() => {});
    host.stop();
    await obs.close();
  }
});

test("stopping the plugin after dispatch preserves request.json so a query-restart refusal remains recoverable", async () => {
  const time = 1_000_000;
  const obs = await realObserverFixture(() => time);
  try {
    const host = fixture([], undefined, false, [], { observer: obs.native, now: () => time, timeoutMs: 120_000, pollMs: 1 });
    const send = host.ref.send;
    let saved: OperationEvidence | undefined;
    host.ref.send = async (text, options) => {
      await send(text, options);
      host.stop();
    };
    const agent = (await host.gateway.refresh("a"))!;
    const outcome = await host.gateway.compact("a", agent, {
      id: "stop-after-dispatch", sendBy: time + 30_000,
      checkpoint: async evidence => { saved = evidence; }, current: () => true,
    });
    assert.equal(outcome.status, "unknown");
    assert.equal(host.sendCount(), 1);
    const req = await obs.readRequest();
    assert.equal(req.status, "prepared", "plugin stop after dispatch must not overwrite prepared request with cancelled");

    // Restarted query now admits and refuses the prepared request.
    const prepared = { launchId: req.launchId, generation: req.generation, sessionId: req.sessionId, revision: req.revision };
    await obs.writeReceipt(req.id, {
      id: req.id, launchId: obs.launchId, generation: "gen-2", sessionId: "native-a", revision: 0,
      status: "failed", reason: "Claude query restarted before compaction ran", observedAt: time + 500,
      refusal: QUERY_RESTARTED_REFUSAL, prepared,
    });
    const restarted = fixture([], undefined, false, [], { observer: obs.native, now: () => time });
    const stored: StoredOperation = {
      id: req.id, agentId: "a", revision: agent.revision!, target: { sessionId: "native-a", activityKey: agent.activityKey ?? null },
      kind: "manual", state: "observing", createdAt: time, updatedAt: time, result: null, inputFingerprint: null,
      evidence: saved,
    };
    const recovered = await restarted.gateway.inspect!(stored);
    assert.equal(recovered?.status, "failed");
    assert.match(recovered.detail, /query restarted/i);
    assert.equal(restarted.sendCount(), 0);
    restarted.stop();
  } finally { await obs.close(); }
});

test("recovery accepts a confirmed query-restart refusal within the deadline and ignores late or ambiguous receipts", async () => {
  const obs = await realObserverFixture(() => 1_000_000);
  try {
    const host = fixture([], undefined, false, [], { observer: obs.native, now: () => 1_000_000 });
    const native = { id: "recover-restart", launchId: obs.launchId, generation: "gen-1", sessionId: "native-a", revision: 2 };
    const operation: StoredOperation = {
      id: native.id, agentId: "a", revision: "rev", target: { sessionId: "native-a", activityKey: null },
      kind: "automatic", state: "observing", createdAt: 1_000_000, updatedAt: 1_000_000, result: null, inputFingerprint: null,
      evidence: { dispatchStartedAt: 1_000_000, native },
    };
    const prepared = { launchId: native.launchId, generation: native.generation, sessionId: native.sessionId, revision: native.revision };
    await obs.writeReceipt(native.id, {
      id: native.id, launchId: obs.launchId, generation: "gen-2", sessionId: "native-a", revision: 0,
      status: "failed", reason: "Claude query restarted before compaction ran", observedAt: 1_000_500,
      refusal: QUERY_RESTARTED_REFUSAL, prepared,
    });
    const recovered = await host.gateway.inspect!(operation);
    assert.equal(recovered?.status, "failed");
    assert.match(recovered.detail, /query restarted/i);

    // Late receipt past the observation deadline is ignored.
    await obs.writeReceipt(native.id, {
      id: native.id, launchId: obs.launchId, generation: "gen-2", sessionId: "native-a", revision: 0,
      status: "failed", reason: "Claude query restarted before compaction ran",
      observedAt: 1_000_000 + OBSERVATION_MS + 1, refusal: QUERY_RESTARTED_REFUSAL, prepared,
    });
    assert.equal(await host.gateway.inspect!(operation), null);

    // Foreign-generation completion never completes recovery, even with a matching timeline boundary.
    host.ref.timeline.refetch = async () => ({ entries: [
      { turnId: "our-turn", item: { type: "user_message", clientMessageId: native.id } },
      { turnId: "our-turn", item: { type: "compaction", status: "completed", trigger: "manual" } },
    ] });
    await obs.writeReceipt(native.id, {
      id: native.id, launchId: obs.launchId, generation: "gen-2", sessionId: "native-a", revision: 0,
      status: "completed", reason: null, observedAt: 1_000_500, refusal: QUERY_RESTARTED_REFUSAL, prepared,
    });
    assert.equal(await host.gateway.inspect!(operation), null);

    // Normal matching completion with matching boundary still succeeds.
    await obs.writeReceipt(native.id, {
      id: native.id, launchId: obs.launchId, generation: "gen-1", sessionId: "native-a", revision: 2,
      status: "completed", reason: null, observedAt: 1_000_500,
    });
    assert.equal((await host.gateway.inspect!(operation))?.status, "completed");
    host.stop();
  } finally { await obs.close(); }
});
