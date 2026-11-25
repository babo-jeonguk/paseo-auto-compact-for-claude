import assert from "node:assert/strict";
import { test } from "node:test";
import { canSubscribe, changedQueries } from "../client/state-events.ts";
import { listKey } from "../client/format.ts";
import { operationKey, sessionKey } from "../client/session-state.ts";
import { stateChangedSubscription } from "../shared/rpc.ts";

const event = agentId => stateChangedSubscription.event.parse({ agentId, revision: 1 });

test("a conversation's surface reads again what a change to it or to everything touches, and nothing for another", () => {
  const view = { hostId: "h", agentId: "a" };
  // Each subscription, including one made again after a reconnect, starts with
  // a change to everything: the host replays nothing missed meanwhile.
  assert.deepEqual(changedQueries(event(null), view), { queryKey: sessionKey("h", "a") });
  assert.deepEqual(changedQueries(event("a"), view), { queryKey: sessionKey("h", "a") });
  assert.equal(changedQueries(event("b"), view), null);
});

test("reading a conversation's status again also reads the operation it tracks, and no other conversation's", () => {
  const prefix = sessionKey("h", "a");
  assert.deepEqual(operationKey("h", "a", "op").slice(0, prefix.length), [...prefix]);
  assert.notDeepEqual(operationKey("h", "b", "op").slice(0, prefix.length), [...prefix]);
  assert.notDeepEqual(sessionKey("h", "b").slice(0, prefix.length), [...prefix]);
});

test("the conversation list reads again for any change, without reading each conversation's status", () => {
  const view = { hostId: "h" };
  for (const agentId of [null, "a", "b"])
    assert.deepEqual(changedQueries(event(agentId), view), { queryKey: listKey("h"), exact: true });
});

test("an app without plugin subscriptions is detected by what it offers, and leaves the surface on its safety poll", () => {
  // The daemon requires 0.16.2, but a phone or desktop app can be older than it.
  assert.equal(canSubscribe({ useSubscription: () => ({ status: "connecting" }) }), true);
  assert.equal(canSubscribe({}), false);
  assert.equal(canSubscribe({ useSubscription: "not a hook" }), false);
});
