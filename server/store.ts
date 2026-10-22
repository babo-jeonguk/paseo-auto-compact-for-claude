import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { StatusSchema } from "../shared/rpc";
import type { State, StateStore } from "./model";

const StateSchema = z.object({
  version: z.literal(1),
  disabled: z.array(z.string()),
  jobs: z.array(
    z.object({
      agentId: z.string(),
      revision: z.string(),
      endedAt: z.number().finite(),
      status: StatusSchema,
      detail: z.string(),
      attemptedAt: z.number().finite().optional(),
      activityKey: z.string().optional(),
      sessionId: z.string().optional(),
      skip: z.object({
        id: z.string().min(1),
        dueAt: z.number().finite(),
        sessionId: z.string().min(1),
      }).optional(),
    })
  ),
});
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
        const state = StateSchema.parse(JSON.parse(await readFile(path, "utf8")));
        for (const job of state.jobs) {
          if (!job.activityKey && ["scheduled", "blocked", "busy", "disabled"].includes(job.status)) {
            job.status = "expired";
            job.detail = "Reservation predates native observation; waiting for new conversation activity";
          }
        }
        return state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { version: 1, disabled: [], jobs: [] };
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
