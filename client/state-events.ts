import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSubscription } from "@getpaseo/plugin/client";
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

// TanStack Query reuses a first read that is still in flight instead of
// refetching it, so an event heard meanwhile would be lost when that read
// captured the state from before the change. Cancelling first makes the
// invalidation start a fresh read after it.
export async function refetchChanged(
  queryClient: QueryClient,
  queries: NonNullable<ReturnType<typeof changedQueries>>,
): Promise<void> {
  await queryClient.cancelQueries(queries);
  await queryClient.invalidateQueries(queries);
}

export function useStateChanges(view: StateChangeView): boolean {
  const queryClient = useQueryClient();
  // Every subscription starts with a null event, including one the app makes
  // again after a reconnect without replaying what was missed, so the first
  // event covers becoming live. While it is not live, the surface's safety
  // poll covers what the subscription would have heard.
  const { status } = useSubscription(
    stateChangedSubscription,
    view.agentId ? { agentId: view.agentId } : {},
    event => {
      const queries = changedQueries(event, view);
      if (queries) void refetchChanged(queryClient, queries);
    },
  );
  return status === "live";
}
