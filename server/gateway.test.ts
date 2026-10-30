import assert from "node:assert/strict";
import { test } from "node:test";
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
  return Object.assign(host, { sendCount: () => sends });
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
    prepare: async () => operation,
    readiness: async () => null,
    result: async () => result,
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
  const foreign = [...boundary, { type: 'user_message', clientMessageId: 'unrelated' }];
  const host = fixture(boundary, undefined, false, foreign, {
    observer: observer({ status: 'completed', detail: 'Native PostCompact' }), timeoutMs: 1_000,
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
