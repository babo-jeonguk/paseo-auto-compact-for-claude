import { defineRpc } from "@getpaseo/plugin";
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
  kind: z.enum(["manual", "automatic"]),
  state: OperationStateSchema,
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  result: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type CompactOperation = z.infer<typeof CompactOperationSchema>;
export const operationPending = (operation: Pick<CompactOperation, "state">) =>
  ["requested", "dispatching", "observing"].includes(operation.state);
export function operationRowStatus(operation: Pick<CompactOperation, "state">) {
  switch (operation.state) {
    case "succeeded": return "completed" as const;
    case "failed": case "unknown": case "expired": return operation.state;
    default: return "running" as const;
  }
}

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
  // Present for an explicit Compact now attempt so the client can correlate
  // its eventual polled outcome without keeping the initiating RPC open.
  operationId: z.string().nullable().default(null),
  busyReason: z.enum(['reply', 'permission', 'input']).nullable().optional(),
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
