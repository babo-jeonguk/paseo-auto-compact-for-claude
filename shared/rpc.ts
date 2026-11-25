import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const StatusSchema = z.enum([
  "scheduled",
  "disabled",
  "busy",
  "blocked",
  "expired",
  "skipped",
  "running",
  "completed",
  "failed",
  "unknown",
]);
// Operation state is independent of reservation/presentation status.
export const OperationStateSchema = z.enum(["requested", "dispatching", "observing", "succeeded", "failed", "expired", "unknown"]);
export const CompactTargetSchema = z.object({
  sessionId: z.string().nullable(),
  activityKey: z.string().nullable(),
});
export type CompactTarget = z.infer<typeof CompactTargetSchema>;
export const CompactOperationSchema = z.object({
  id: z.string().min(1),
  agentId: z.string(),
  revision: z.string(),
  target: CompactTargetSchema,
  // Releases before operations did not record who asked; their history is "legacy".
  kind: z.enum(["manual", "automatic", "legacy"]),
  state: OperationStateSchema,
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  // One of RESULT_CODES; read as a plain string so a code from a newer release
  // still reads after a rollback.
  result: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type CompactOperation = z.infer<typeof CompactOperationSchema>;
// Every result code this release writes. The `_before_dispatch` codes prove
// nothing was sent; the others may have sent.
export const RESULT_CODES = ["completed", "unknown", "failed_before_dispatch", "failed_after_dispatch",
  "expired_before_dispatch", "legacy_outcome"] as const;
export type ResultCode = typeof RESULT_CODES[number];
const SENT_NOTHING: readonly ResultCode[] = ["failed_before_dispatch", "expired_before_dispatch"];
// Whether a result proves nothing was sent, so trying again is safe.
export const sentNothing = (code: string | undefined) => SENT_NOTHING.includes(code as ResultCode);
export const operationPending = (operation: Pick<CompactOperation, "state">) =>
  ["requested", "dispatching", "observing"].includes(operation.state);
// The two directions between an operation's state and a row/outcome status;
// the only places these vocabularies are translated.
export function operationRowStatus(operation: Pick<CompactOperation, "state">) {
  switch (operation.state) {
    case "succeeded": return "completed" as const;
    case "failed": case "unknown": case "expired": return operation.state;
    default: return "running" as const;
  }
}
export const finishedState = (status: "completed" | "failed" | "unknown" | "expired") =>
  status === "completed" ? "succeeded" as const : status;

// Why nothing is compacted in a session the host must reopen first.
export const SESSION_RESUME_REQUIRED = "Session must resume after plugin reload; send a message before compacting";

// Why a row is blocked. The controls choose their explanation from this code
// alone; `detail` is the human-readable reason and may be reworded freely.
export const BLOCKED_REASONS = [
  "settings_unreadable",
  "context_usage_unknown",
  // This host cannot run the observer at all, so nothing is automatic.
  "observer_not_supported",
  // The session's observer has not written yet and no turn has finished since
  // its launch was prepared: normal startup.
  "observer_starting",
  // The observer's file exists but could not be read just now.
  "observer_unreadable",
  // No usable observer for this session; reopening it may load one.
  "observer_missing",
  "resume_required",
  "claude_working",
  "waiting_for_reply",
  "cache_window_passed",
  "idle_delay_exceeds_cache",
  "policy_changed",
  "waiting_for_turn",
] as const;
export const BlockedReasonSchema = z.enum(BLOCKED_REASONS);
export type BlockedReason = typeof BLOCKED_REASONS[number];
export type Blocked = { reason: BlockedReason; detail: string };
// Stored codes are read as plain strings so a code from a newer release still
// reads after a rollback; one this release does not know is dropped.
export const knownBlockedReason = (code: string | undefined): BlockedReason | undefined =>
  BLOCKED_REASONS.includes(code as BlockedReason) ? code as BlockedReason : undefined;

export const RowSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  workspace: z.string(),
  provider: z.string(),
  tokens: z.number().nullable(),
  revision: z.string().nullable(),
  enabled: z.boolean(),
  target: CompactTargetSchema.optional(),
  activeOperation: CompactOperationSchema.nullable().optional(),
  latestOperation: CompactOperationSchema.nullable().optional(),
  // Only pending reservations have a due time; finished jobs keep their history privately.
  dueAt: z.number().nullable(),
  // Separate from an active reservation: only an explicit, still reversible skip.
  undoSkip: z.object({ id: z.string(), dueAt: z.number() }).nullable().default(null),
  status: StatusSchema,
  detail: z.string(),
  // Only for a blocked row. Absent from older servers.
  blockedReason: BlockedReasonSchema.optional(),
  // Present for an explicit Compact now attempt so the client can correlate
  // its eventual polled outcome without keeping the initiating RPC open.
  operationId: z.string().nullable().default(null),
  busyReason: z.enum(['reply', 'permission', 'input']).nullable().optional(),
  // Nothing is compacted until an ordinary message resumes the session (see Observation).
  resumeRequired: z.boolean().optional(),
  inputIdleSince: z.number().nullable().optional(),
  cache: z.object({ ttlMinutes: z.number(), source: z.enum(['transcript', 'settings', 'environment', 'default']),
    deadline: z.number(), observedAt: z.number().optional(), mixed: z.boolean().optional() }).nullable().optional(),
});
export type Row = z.infer<typeof RowSchema>;
export const sessionRpc = defineRpc({
  name: "auto-compact.session",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ row: RowSchema.nullable() }),
});
export const listRpc = defineRpc({
  name: "auto-compact.list",
  input: z.object({}),
  output: z.object({
    rows: z.array(RowSchema),
    automaticDispatch: z.boolean(),
    providers: z.array(z.object({ id: z.string(), label: z.string() })),

  }),
});
export const toggleRpc = defineRpc({
  name: "auto-compact.toggle",
  input: z.object({ agentId: z.string().min(1), enabled: z.boolean() }),
  output: z.object({ changed: z.boolean() }),
});
export const skipRpc = defineRpc({
  name: "auto-compact.skip",
  input: z.object({ agentId: z.string(), revision: z.string() }),
  output: z.object({ changed: z.boolean() }),
});
export const undoSkipRpc = defineRpc({
  name: "auto-compact.undo-skip",
  input: z.object({
    agentId: z.string().min(1),
    revision: z.string().min(1),
    skipId: z.string().min(1),
  }),
  output: z.object({ changed: z.boolean() }),
});
export const compactRpc = defineRpc({
  name: "auto-compact.now",
  input: z.object({
    agentId: z.string(), revision: z.string(),
    // Optional only for clients mounted before the upgrade. New clients supply both.
    operationId: z.string().uuid().optional(),
    target: CompactTargetSchema.optional(),
  }),
  output: z.object({
    status: StatusSchema,
    detail: z.string(),
    operationId: z.string().nullable().default(null),
    operation: CompactOperationSchema.nullable(),
    code: z.enum(["accepted", "existing", "blocked", "idempotency_conflict"]),
  }),
});
export const operationRpc = defineRpc({
  name: "auto-compact.operation",
  input: z.object({ operationId: z.string().min(1) }),
  output: z.object({ operation: CompactOperationSchema.nullable() }),
});
// Pushed when a save changes what a screen shows of the plugin's state. It
// names only what changed: the conversation, or null when settings changed or
// the change cannot be narrowed, which means "read everything again". Screens
// read the state itself through the RPCs above, so a missed or late event
// never shows wrong state. Narrowed to one conversation, a subscription still
// hears the null events. The revision moves on with every event a plugin
// instance pushes and starts again when it restarts.
export const stateChangedSubscription = defineSubscription({
  name: "auto-compact.state-changed",
  input: z.object({ agentId: z.string().min(1).optional() }),
  event: z.object({ agentId: z.string().min(1).nullable(), revision: z.number().int().nonnegative() }),
});
