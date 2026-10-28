import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  usePaseo,
  useRpc,
  useSettings,
  type PluginButtonContentProps,
} from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { operationRowStatus, operationPending, compactRpc, operationRpc, sessionRpc, skipRpc, toggleRpc, undoSkipRpc } from "../shared/rpc";
import { compactSettings } from "../shared/settings";
import { canSkip, errorLabel, tokenLabel } from "./format";
import { canUndoSkip, compactCompletionNotice, pendingPresentation, sessionKey,
  sessionPresentation, type Presentation } from "./session-state";
import { compactSubmissions } from "./compact-submission";
import { Toggle } from "./toggle";

export function useConversation(hostId: string, agentId: string) {
  const read = useRpc(sessionRpc);
  const settings = useSettings(compactSettings);
  const queryClient = useQueryClient();
  const paseo = usePaseo();
  const key = sessionKey(hostId, agentId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => read({ agentId }),
    refetchInterval: 2_000,
    retry: false,
  });
  const mutations = useIsMutating({ mutationKey: key });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(
    () =>
      paseo.agents.ref(agentId).subscribe(() => {
        void queryClient.invalidateQueries({ queryKey: sessionKey(hostId, agentId) });
      }),
    [paseo, agentId, hostId, queryClient]
  );
  const row = query.data?.row ?? null;
  const fresh = !query.isError && query.dataUpdatedAt > 0 && now - query.dataUpdatedAt < 6_000;
  const ready = fresh && !!row && settings.status === "ready";
  const previous = useRef<Presentation | null>(null);
  const pendingSince = useRef<number | null>(null);
  const current = ready ? sessionPresentation(row!, settings.values, now) : null;
  if (current) {
    previous.current = current;
    pendingSince.current = null;
  } else {
    pendingSince.current ??= now;
  }
  const display = current?.label === "Compacting…"
    ? { presentation: current, loading: false }
    : mutations
    ? pendingPresentation(previous.current, 0, true)
    : settings.status === "invalid" || settings.status === "error"
    ? { presentation: { label: "Check compact", description: "Compact settings could not be read. Open Settings to check them." }, loading: false }
    : fresh && !row
    ? { presentation: { label: "Check compact", description: "Automatic compaction is unavailable for this conversation. Refresh the status." }, loading: false }
    : current
    ? { presentation: current, loading: false }
    : pendingPresentation(previous.current, now - (pendingSince.current ?? now));
  return { row, query, settings, ready, status: display.presentation?.label ?? null,
    description: display.presentation?.description ?? "Loading compact status…",
    loading: display.loading, mutations, now };
}

export function ConversationControls({
  agentId,
  host,
  theme,
  layout,
  onSettings,
}: PluginButtonContentProps & { agentId: string; onSettings(): void }) {
  const state = useConversation(host.id, agentId);
  const { row, query, settings, ready, status } = state;
  const queryClient = useQueryClient();
  const toast = useToast();
  const toggle = useRpc(toggleRpc), skip = useRpc(skipRpc), compact = useRpc(compactRpc);
  const undoSkip = useRpc(undoSkipRpc);
  const readOperation = useRpc(operationRpc);
  const key = sessionKey(host.id, agentId);
  const [confirmRevision, setConfirmRevision] = useState<string | null>(null);
  const [compactOperationId, setCompactOperationId] = useState<string | null>(
    () => compactSubmissions.get(host.id, agentId)?.operationId ?? null);
  const trackedId = compactOperationId ?? row?.activeOperation?.id ?? null;
  const operationQuery = useQuery({
    queryKey: ["auto-compact", host.id, "operation", trackedId],
    queryFn: () => readOperation({ operationId: trackedId! }),
    enabled: !!trackedId,
    refetchInterval: query => query.state.data?.operation &&
      !operationPending(query.state.data.operation) ? false : 2_000,
    retry: false,
  });
  const operation = operationQuery.data?.operation ?? row?.activeOperation ?? row?.latestOperation;
  useEffect(() => {
    setCompactOperationId(compactSubmissions.get(host.id, agentId)?.operationId ?? null);
  }, [host.id, agentId]);
  useEffect(() => setConfirmRevision(null), [row?.revision]);

  const action = useMutation({
    mutationKey: key,
    mutationFn: async (input:
      | { kind: "toggle"; enabled: boolean }
      | { kind: "skip"; revision: string }
      | { kind: "undo-skip"; revision: string; skipId: string }
      | { kind: "compact"; revision: string }
    ) => {
      // Prevent a pre-mutation poll from overwriting the acknowledged result.
      await queryClient.cancelQueries({ queryKey: key });
      if (input.kind === "toggle") {
        const result = await toggle({ agentId, enabled: input.enabled });
        if (!result.changed) throw new Error("Couldn’t update this conversation. Try again.");
        return { kind: input.kind, enabled: input.enabled } as const;
      }
      if (input.kind === "skip") {
        const result = await skip({ agentId, revision: input.revision });
        if (!result.changed) throw new Error("This schedule changed. Refresh and try again.");
        return { kind: input.kind } as const;
      }
      if (input.kind === "undo-skip") {
        const result = await undoSkip({ agentId, revision: input.revision, skipId: input.skipId });
        if (!result.changed) throw new Error("This skipped schedule changed or expired. Refresh and try again.");
        return { kind: input.kind } as const;
      }
      const submission = compactSubmissions.prepare(host.id, {
        agentId, revision: input.revision, target: row?.target,
      });
      setCompactOperationId(submission.operationId);
      const result = await compact(submission);
      compactSubmissions.acknowledge(host.id, agentId, submission.operationId);
      return { kind: input.kind, ...result } as const;
    },
    onSuccess: (result) => {
      // These updates happen only after the server acknowledges the action.
      queryClient.setQueryData<{ row: typeof row }>(key, (current) => {
        if (!current?.row) return current;
        return {
          row: result.kind === "toggle"
            ? { ...current.row, enabled: result.enabled }
            : result.kind === "skip"
            ? { ...current.row, status: "skipped", dueAt: null, undoSkip: null,
                detail: "This reservation skipped; session policy unchanged" }
            : result.kind === "undo-skip"
            ? { ...current.row, status: "blocked", dueAt: null, undoSkip: null,
                detail: "Waiting for refreshed schedule" }
            : { ...current.row, status: result.status, detail: result.detail,
                operationId: result.operationId, dueAt: null, undoSkip: null,
                activeOperation: result.operation && operationPending(result.operation) ? result.operation : null,
                latestOperation: result.operation ?? current.row.latestOperation },
        };
      });
      if (result.kind === "skip") toast.show("Skipped this schedule");
      if (result.kind === "undo-skip") toast.show("Skip undone");
      if (result.kind === "compact") {
        setConfirmRevision(null);
        if (result.status === "running") {
          setCompactOperationId(result.operationId);
          toast.show("Compaction requested");
        } else {
          setCompactOperationId(null);
          if (result.status === "completed") toast.show("Conversation compacted", { variant: "success" });
          else toast.error(result.status === "unknown"
          ? "Check the conversation before trying again."
          : result.status === "blocked"
          ? `${result.detail}.`
          : "Couldn’t compact. Check the conversation.");
        }
      }
    },
    onError: (error, input) => {
      if (input.kind === "compact") toast.show("Request status unconfirmed. Checking compaction status.");
      else toast.error(errorLabel(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  useEffect(() => {
    if (operation && operation.id === compactOperationId) {
      compactSubmissions.acknowledge(host.id, agentId, operation.id);
      if (action.isError && action.variables?.kind === "compact") action.reset();
    }
    if (action.isPending) return;
    const notice = compactCompletionNotice(operation ? {
      operationId: operation.id,
      status: operationRowStatus(operation),
    } : null, compactOperationId);
    if (!notice) return;
    setCompactOperationId(null);
    if (notice.variant === "success") toast.show(notice.message, { variant: "success" });
    else toast.error(notice.message);
  }, [compactOperationId, operation?.id, operation?.state, toast, host.id, agentId, action.isPending, action.isError]);
  const busy = state.mutations > 0 || row?.status === "running" || !!operation && operationPending(operation);
  const disabled = !ready || busy;
  const { colors } = theme;
  const textStyle = { color: colors.foreground, fontSize: 14 };
  const mutedStyle = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 };
  const buttonStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingVertical: 9,
    paddingHorizontal: 12,
  };
  const button = (label: string, onPress: () => void, isDisabled = false, icon?: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [buttonStyle,
        { opacity: isDisabled ? 0.4 : 1, backgroundColor: pressed ? colors.surface2 : "transparent" }]}
    >
      {icon ? <Icon name={icon} size={14} color={colors.foreground} /> : null}
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
  const automaticOff = settings.status === "ready" &&
    (!settings.values.enabled || !!row && settings.values.disabledProviders.includes(row.provider));
  return (
    <View testID={`compact-conversation-${agentId}`} style={{ padding: 16, gap: 16, width: "100%", maxWidth: 360 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ ...textStyle, fontSize: layout.compact ? 14 : 16, fontWeight: "600" }} accessibilityRole="header">{status ?? "Auto Compact"}</Text>
          <Text style={mutedStyle}>{state.description}</Text>
        </View>
        {state.loading ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : null}
      </View>
      {row?.tokens != null && settings.status === "ready"
        ? <Text style={mutedStyle}>{tokenLabel(row.tokens)} / {tokenLabel(settings.values.threshold)} context tokens</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={textStyle}>Auto compact this conversation</Text>
          {automaticOff ? <Text style={mutedStyle}>Also enable automation in Settings.</Text> : null}
        </View>
        <Toggle theme={theme} value={row?.enabled ?? false} disabled={disabled}
          accessibilityLabel="Auto compact this conversation"
          onValueChange={(enabled) => action.mutate({ kind: "toggle", enabled })} />
      </View>
      {action.isError ? <Text accessibilityRole="alert" style={{ ...mutedStyle, color: colors.statusDanger }}>
        {action.variables?.kind === "toggle"
          ? "Couldn’t update this conversation. Try again."
          : action.variables?.kind === "compact"
          ? "Request status unconfirmed. Refresh status or retry the same request."
          : "This action failed. Refresh the status and try again."}
      </Text> : null}
      {operation ? <Text style={mutedStyle}>
        {operationPending(operation) ? "Compaction requested"
          : `Last compaction: ${operation.result?.message ?? operation.state}`}
      </Text> : null}
      {button("Skip this time", () => action.mutate({ kind: "skip", revision: row!.revision! }),
        disabled || !row || !canSkip(row) || !status?.startsWith("Compact in "), "SkipForward")}
      {ready && row && canUndoSkip(row, state.now) ? <View style={{ gap: 6 }}>
        {button("Undo skip", () => action.mutate({
          kind: "undo-skip", revision: row.revision!, skipId: row.undoSkip!.id,
        }), disabled, "Undo2")}
        <Text style={mutedStyle}>Restores the skipped schedule.</Text>
      </View> : null}
      {ready && row?.status === "skipped" && !canUndoSkip(row, state.now) &&
       row.detail === "This reservation skipped; session policy unchanged"
        ? <Text style={mutedStyle}>This skip can no longer be undone.</Text> : null}
      <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 16 }}>
      {confirmRevision && confirmRevision === row?.revision ? <View style={{ gap: 10 }}>
        <Text style={textStyle}>Compact this conversation? Older messages will be summarized.</Text>
        <Text style={mutedStyle}>Keep this conversation idle until compaction finishes.</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {button("Confirm compact", () => action.mutate({ kind: "compact", revision: confirmRevision }), disabled)}
          {button("Cancel", () => setConfirmRevision(null), state.mutations > 0)}
        </View>
      </View> : button("Compact now", () => setConfirmRevision(row!.revision!),
        disabled || !row?.revision || row.status === "busy", "Minimize2")}
      </View>
      {status === "Check compact" || query.isError || !ready && !query.isPending ? button("Refresh status", () => {
        void query.refetch();
        void settings.reload();
      }, query.isFetching, "RefreshCw") : null}
      {button("Settings", onSettings, false, "Settings2")}
    </View>
  );
}
