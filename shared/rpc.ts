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
export const RowSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  workspace: z.string(),
  provider: z.string(),
  tokens: z.number().nullable(),
  revision: z.string().nullable(),
  enabled: z.boolean(),
  // Only pending reservations have a due time; finished jobs keep their history privately.
  dueAt: z.number().nullable(),
  // Separate from an active reservation: only an explicit, still reversible skip.
  undoSkip: z.object({ id: z.string(), dueAt: z.number() }).nullable().default(null),
  status: StatusSchema,
  detail: z.string(),
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
  input: z.object({ agentId: z.string(), revision: z.string() }),
  output: z.object({ status: StatusSchema, detail: z.string() }),
});
