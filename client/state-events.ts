import { useQueryClient } from "@tanstack/react-query";
import * as pluginClient from "@getpaseo/plugin/client";
import { stateChangedSubscription } from "../shared/rpc";
import { listKey } from "./format";
import { sessionKey } from "./session-state";

export interface StateChangeEvent {
  agentId: string | null;
  revision: number;
}

export interface StateChangeView {
  hostId: string;
  agentId?: string;
}

// The daemon requires 0.16.2, but a phone or desktop app can be older than it
// and then offers no subscription hook. The app supplies this SDK module at run
// time, so the hook is looked up on it rather than assumed from its types.
export const canSubscribe = (sdk: { useSubscription?: unknown }): boolean =>
  typeof sdk.useSubscription === "function";

export function changedQueries(event: StateChangeEvent, view: StateChangeView) {
  if (view.agentId)
    // A null event means "read everything again", which includes this
    // conversation; another conversation's change is not this surface's.
    return event.agentId === null || event.agentId === view.agentId
      ? { queryKey: sessionKey(view.hostId, view.agentId) }
      : null;
  // Every key on this host starts with the list key, so only the list itself
  // reads again; `exact` keeps the conversations on their own polls.
  return { queryKey: listKey(view.hostId), exact: true };
}

// A constant, so the hook below is called in the same order on every render.
const subscribable = canSubscribe(pluginClient);

export function useStateChanges(view: StateChangeView): void {
  const queryClient = useQueryClient();
  if (!subscribable) return;
  // Every subscription starts with a null event, including one the app makes
  // again after a reconnect without replaying what was missed, so the first
  // event covers becoming live. A subscription that is connecting, closed, in
  // error or unavailable is covered by the surface's safety poll.
  pluginClient.useSubscription(
    stateChangedSubscription,
    view.agentId ? { agentId: view.agentId } : {},
    event => {
      const queries = changedQueries(event, view);
      if (queries) void queryClient.invalidateQueries(queries);
    },
  );
}
