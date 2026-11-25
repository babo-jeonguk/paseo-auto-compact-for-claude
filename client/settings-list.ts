import type { UseQueryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import { listRpc } from "../shared/rpc";
import { listPollDelay } from "./cadence";
import { listKey } from "./format";

type ListResult = z.output<typeof listRpc.output>;

// The Settings screen's list query: its subscription refreshes it on every
// change, and it polls itself only while that subscription is not live or its
// last read failed.
export function settingsListQuery(input: {
  hostId: string;
  read: () => Promise<ListResult>;
  live: boolean;
  active: boolean;
}): UseQueryOptions<ListResult> {
  return {
    queryKey: listKey(input.hostId),
    queryFn: () => input.read(),
    refetchInterval: query => listPollDelay({
      live: input.live,
      active: input.active,
      failed: query.state.status === "error",
    }),
  };
}
