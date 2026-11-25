import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { changedQueries, refetchChanged } from "../client/state-events.ts";
import { cleanupScope } from "./support/scope.ts";
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

test("a change heard while a screen's first read is in flight reads again after it, instead of keeping that read", async (t) => {
  const scope = cleanupScope(t);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  scope.defer(() => client.clear());
  let reads = 0;
  let firstStarted, releaseFirst;
  const started = new Promise(resolve => { firstStarted = resolve; });
  // The first read captures the state from before the change and answers after the change's event.
  const queryFn = () => {
    reads++;
    if (reads > 1) return Promise.resolve("after the change");
    firstStarted();
    return new Promise(resolve => { releaseFirst = () => resolve("before the change"); });
  };
  const observer = new QueryObserver(client, { queryKey: listKey("h"), queryFn });
  scope.defer(observer.subscribe(() => {}));
  await started;
  const refreshed = refetchChanged(client, changedQueries(event(null), { hostId: "h" }));
  releaseFirst();
  await refreshed;
  assert.equal(reads, 2);
  assert.equal(client.getQueryData(listKey("h")), "after the change");
});

test("several changes heard during one read lead to one more read after it, not one each", async (t) => {
  const scope = cleanupScope(t);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  scope.defer(() => client.clear());
  let reads = 0;
  let secondStarted, releaseSecond;
  const started = new Promise(resolve => { secondStarted = resolve; });
  const queryFn = () => {
    reads++;
    if (reads !== 2) return Promise.resolve(`read ${reads}`);
    secondStarted();
    return new Promise(resolve => { releaseSecond = () => resolve("read 2"); });
  };
  const observer = new QueryObserver(client, { queryKey: listKey("h"), queryFn });
  const first = new Promise(resolve => { scope.defer(observer.subscribe(result => { if (result.data) resolve(); })); });
  await first;
  const view = { hostId: "h" };
  const refreshes = [refetchChanged(client, changedQueries(event("a"), view))];
  await started;
  // The plugin's request cannot be stopped once sent, so the reads must not overlap.
  for (const agentId of ["a", "b", null]) refreshes.push(refetchChanged(client, changedQueries(event(agentId), view)));
  releaseSecond();
  await Promise.all(refreshes);
  assert.equal(reads, 3);
  assert.equal(client.getQueryData(listKey("h")), "read 3");
});

// Without its own wait, the operation's read would wait for the held status
// read, which only the operation's read releases; the timeout ends that.
test("a change reads each of a conversation's queries again when its own read ends, not when another's does", { timeout: 5_000 }, async (t) => {
  const scope = cleanupScope(t);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  scope.defer(() => client.clear());
  const order = [];
  let statusReads = 0, operationReads = 0, releaseStatus;
  const statusFn = () => {
    statusReads++;
    order.push(`status ${statusReads}`);
    if (statusReads !== 2) return Promise.resolve(`status ${statusReads}`);
    return new Promise(resolve => { releaseStatus = () => resolve("status 2"); });
  };
  const operationFn = () => {
    operationReads++;
    order.push(`operation ${operationReads}`);
    // The operation read after the change ends the slow status read.
    if (operationReads === 2) releaseStatus();
    return Promise.resolve(`operation ${operationReads}`);
  };
  const mounted = (queryKey, queryFn) => {
    const observer = new QueryObserver(client, { queryKey, queryFn });
    return new Promise(resolve => { scope.defer(observer.subscribe(result => { if (result.data) resolve(observer); })); });
  };
  const status = await mounted(sessionKey("h", "a"), statusFn);
  await mounted(operationKey("h", "a", "op"), operationFn);
  // A slow status read is in flight when the operation's result is saved.
  const slow = status.refetch();
  assert.equal(client.isFetching({ queryKey: sessionKey("h", "a"), exact: true }), 1);
  await refetchChanged(client, changedQueries(event("a"), { hostId: "h", agentId: "a" }));
  await slow;
  assert.deepEqual(order, ["status 1", "operation 1", "status 2", "operation 2", "status 3"]);
});
