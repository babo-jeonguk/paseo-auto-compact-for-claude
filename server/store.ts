import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { JobSchema, StoredOperationSchema, type State, type StateStore } from "./model";
import { finishedState } from "../shared/rpc";

// Jobs as v1.0.2 wrote them, plus their operation link. Unknown keys are dropped,
// just as v1.0.2 drops ours.
const LegacyStateSchema = z.object({
  version: z.literal(1),
  disabled: z.array(z.string()),
  jobs: z.array(JobSchema),
});
// Additive: a file without `operations` is v1.0.2's, or rolled back through it.
const StateSchema = LegacyStateSchema.extend({
  operations: z.array(StoredOperationSchema),
}).superRefine((state, context) => {
  const ids = state.operations.map(operation => operation.id);
  if (new Set(ids).size !== ids.length)
    context.addIssue({ code: "custom", message: "Duplicate operation identities" });
});

function decode(value: unknown): State {
  if ((value as { operations?: unknown })?.operations !== undefined) return StateSchema.parse(value);
  const legacy = LegacyStateSchema.parse(value);
  const operations: State["operations"] = [];
  for (const job of legacy.jobs) {
    if (!["running", "completed", "failed", "unknown"].includes(job.status)) continue;
    // Stable IDs make repeated reads/migration retries deterministic.
    const id = "legacy-" + createHash("sha256").update(JSON.stringify([
      job.agentId, job.revision, job.attemptedAt ?? job.endedAt,
    ])).digest("hex");
    if (job.status === "running") {
      job.status = "unknown";
      job.detail = "Plugin restarted during compaction; no automatic retry";
    }
    operations.push({
      id, agentId: job.agentId, revision: job.revision,
      target: { sessionId: job.sessionId ?? null, activityKey: job.activityKey ?? null },
      kind: "legacy", inputFingerprint: null,
      state: finishedState(job.status as "completed" | "failed" | "unknown"),
      createdAt: job.attemptedAt ?? job.endedAt, updatedAt: job.attemptedAt ?? job.endedAt,
      result: { code: "legacy_outcome", message: job.detail },
    });
    job.operationId = id;
  }
  return StateSchema.parse({ ...legacy, operations });
}

export function createStore(
  path = join(
    process.env.PASEO_HOME || join(homedir(), ".paseo"),
    "plugin-data",
    "auto-compact-for-claude",
    "state.json"
  )
): StateStore {
  return {
    async read() {
      try {
        const state = decode(JSON.parse(await readFile(path, "utf8")));
        for (const job of state.jobs) {
          if (!job.activityKey && ["scheduled", "blocked", "busy", "disabled"].includes(job.status)) {
            job.status = "expired";
            job.detail = "Reservation predates native observation; waiting for new conversation activity";
          }
        }
        return state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { version: 1, disabled: [], jobs: [], operations: [] };
        // Do not discard disabled policies or processed revisions on corruption.
        throw new Error(
          "Auto Compact state is unreadable; automation stopped",
          { cause: error }
        );
      }
    },
    async write(state: State) {
      StateSchema.parse(state);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(state, null, 2) + "\n", {
          mode: 0o600,
        });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    },
  };
}
