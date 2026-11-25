import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { settingsListQuery } from "../client/settings-list.ts";
import { changedQueries, refetchChanged } from "../client/state-events.ts";
import { listKey } from "../client/format.ts";
import { SESSION_POLL_MS } from "../client/cadence.ts";
import { stateChangedSubscription } from "../shared/rpc.ts";
import { cleanupScope } from "./support/scope.ts";

const event = agentId => stateChangedSubscription.event.parse({ agentId, revision: 1 });
// The refetch interval the screen's query asks for after a read that ended in `status`.
const interval = (options, status) => options.refetchInterval({ state: { status } });

test("the Settings list polls at the safety interval while its subscription is not live or its last read failed", () => {
  const read = async () => ({ rows: [] });
  const connecting = settingsListQuery({ hostId: "h", read, live: false, active: true });
  assert.deepEqual(connecting.queryKey, listKey("h"));
  assert.equal(interval(connecting, "success"), SESSION_POLL_MS);
  const live = settingsListQuery({ hostId: "h", read, live: true, active: true });
  assert.equal(interval(live, "success"), false);
  assert.equal(interval(live, "error"), SESSION_POLL_MS);
  assert.equal(interval(settingsListQuery({ hostId: "h", read, live: false, active: false }), "success"), false);
});

test("a change refetches the mounted Settings list through its own query, and a failed read stays visible for the poll", async (t) => {
  const scope = cleanupScope(t);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  scope.defer(() => client.clear());
  const answers = [{ rows: [] }, new Error("directory read timed out"), { rows: [{ id: "a" }] }];
  let reads = 0;
  const read = async () => {
    const answer = answers[reads++];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const options = settingsListQuery({ hostId: "h", read, live: true, active: true });
  const observer = new QueryObserver(client, options);
  const first = new Promise(resolve => { scope.defer(observer.subscribe(result => { if (result.data) resolve(); })); });
  await first;
  const change = agentId => refetchChanged(client, changedQueries(event(agentId), { hostId: "h" }));
  await change("a");
  assert.equal(reads, 2);
  const failed = client.getQueryCache().find({ queryKey: listKey("h") });
  assert.equal(failed.state.status, "error");
  assert.equal(options.refetchInterval(failed), SESSION_POLL_MS, "the failed read is read again at the safety interval");
  await change(null);
  assert.equal(reads, 3);
  assert.deepEqual(client.getQueryData(listKey("h")), { rows: [{ id: "a" }] });
  assert.equal(options.refetchInterval(failed), false, "once a read succeeds, the live subscription takes over again");
});
