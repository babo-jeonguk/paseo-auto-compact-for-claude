import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded } from "./deadline";
import { Refusal, type OperationEvidence, type StoredOperation } from "./model";
import { createGateway } from "./gateway";
import type {
  PluginHandlerContext,
  PluginLifecycleEvents,
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
  return Object.assign(host, { ref, sendCount: () => sends });
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

test("completed command ownership is released; stock gateway offers no automatic dispatch", async () => {
  const host = fixture([]);
  const running = host.gateway.compact("a");
  await running;
  assert.equal(host.ownTurn("a", "compact-1"), false);
  assert.equal(host.gateway.automatic, undefined);
  host.stop();
});

function observer(result: { status: 'completed' | 'unknown'; detail: string } | null) {
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
    const host = fixture(boundary, undefined, false, boundary, { observer: observer(receipt) });
    const agent = (await host.gateway.refresh('a'))!;
    assert.equal((await host.gateway.automatic!(agent)).status, expected);
    assert.equal(host.sendCount(), 1);
  }
  const foreign = [...boundary, { type: 'user_message', clientMessageId: 'unrelated' }];
  const host = fixture(boundary, undefined, false, foreign, {
    observer: observer({ status: 'completed', detail: 'Native PostCompact' }),
  });
  assert.equal((await host.gateway.automatic!((await host.gateway.refresh('a'))!)).status, 'unknown');
});

test('last-moment off policy and expired delivery prevent public send', async () => {
  for (const guard of [
    { expiresAt: Date.now() + 30000, allowed: async () => false },
    { expiresAt: 0, allowed: async () => true },
  ]) {
    const host = fixture([], undefined, false, [], { observer: observer(null) });
    assert.equal((await host.gateway.automatic!((await host.gateway.refresh('a'))!, guard)).status, 'failed');
    assert.equal(host.sendCount(), 0);
  }
});

test('an observer refusal is a failed outcome; any other error before sending is thrown', async () => {
  for (const [error, refused] of [[new Refusal('Claude is still working'), true], [new Error('EIO'), false]] as const) {
    const native = observer(null)!;
    native.prepare = async () => { throw error; };
    const host = fixture([], undefined, false, [], { observer: native });
    const agent = (await host.gateway.refresh('a'))!;
    if (refused) assert.equal((await host.gateway.compact('a', agent)).status, 'failed');
    else await assert.rejects(host.gateway.compact('a', agent), /EIO/);
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
    return current ? { ...current, ledger: { ...current.ledger, pendingInputs, activeTurns,
      ordinaryEndedAt: 1000 } } : null;
  };
  const host = fixture([], undefined, false, [], { observer: native });
  const stuck = (await host.gateway.refresh('a'))!;
  assert.equal(stuck.idle, false);
  assert.equal(stuck.busyReason, 'input');
  assert.equal(stuck.inputIdleSince, 1000);
  assert.equal((await host.gateway.automatic!(stuck)).status, 'failed');
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
      await assert.rejects(bounded(host.gateway.compact("a"), 2_000), /deadline/i, stalled);
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
    id: "caller-request", deadlineAt: Date.now() + 1000,
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
    id: "caller-request", deadlineAt: Date.now() + 1000,
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
  operation.evidence!.invalidated = true;
  assert.equal((await host.gateway.inspect!(operation))?.status, "unknown");
  operation.evidence!.invalidated = false;
  operation.deadlineAt = 1000;
  native.receipt = async () => ({ status: "completed", detail: "late receipt", observedAt: 1001 });
  assert.equal(await host.gateway.inspect!(operation), null, "late completion cannot extend the operation deadline");
});

test('native activity identity survives compaction without restoring its scheduling window', async () => {
  const native = observer(null)!;
  const initial = (await native.read('a'))!;
  let ledger = initial.ledger;
  native.read = async () => ({ ...initial, ledger });
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
