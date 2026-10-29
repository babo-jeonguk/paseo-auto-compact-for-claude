// Writes state-v1.0.2.json with the released v1.0.2 scheduler and store, so the
// migration tests read what that release really wrote. From the repository root:
//   git worktree add --detach /tmp/v1.0.2 v1.0.2 && ln -s "$PWD/node_modules" /tmp/v1.0.2/
//   node --import tsx tests/fixtures/state-v1.0.2.generate.mts /tmp/v1.0.2 tests/fixtures/state-v1.0.2.json
import { writeFileSync, readFileSync } from "node:fs";
const root = process.argv[2], out = process.argv[3];
const { createScheduler } = await import(`${root}/server/scheduler.ts`);
const { createStore } = await import(`${root}/server/store.ts`);
const { DEFAULT_SETTINGS } = await import(`${root}/shared/settings.ts`);
let time = Date.parse("2026-10-01T00:00:00Z");
const path = `${out}.tmp.json`;
writeFileSync(path, JSON.stringify({ version: 1, disabled: [], jobs: [] }));
const agent = (id: string, n: number) => ({ agentId: id, title: id, workspace: "/work", provider: "claude",
  revision: new Date(time - n * 1000).toISOString(), tokens: 250_000, eligible: true, idle: true,
  sessionId: `native-${id}`, activityKey: `launch-${id}:generation-1:${n}` });
const agents = new Map<string, ReturnType<typeof agent>>();
let hang: Promise<never> | null = null;
const outcomes = new Map<string, { status: "completed" | "failed" | "unknown"; detail: string }>();
const run = async (id: string) => { if (id === "interrupted") return hang = new Promise<never>(() => {});
  return outcomes.get(id) ?? { status: "completed", detail: "Compaction completed in the same Claude session" }; };
const gateway = { list: async () => [...agents.values()], refresh: async (id: string) => agents.get(id) ?? null,
  compact: (id: string) => run(id), automatic: (a: { agentId: string }) => run(a.agentId), readiness: async () => null };
const s = createScheduler({ store: createStore(path), gateway, settings: async () => ({ ...DEFAULT_SETTINGS }), now: () => time });
await s.ready;
for (const [id, n] of [["off", 2], ["manual", 3], ["automatic", 4], ["skipped", 5], ["failed", 6], ["interrupted", 7]] as const) {
  agents.set(id, agent(id, n)); await s.observedTurn(agents.get(id)!, time - 1000);
}
await s.toggle("off", false);
await s.skip("skipped", agents.get("skipped")!.revision);
outcomes.set("failed", { status: "failed", detail: "Compact turn failed or was cancelled; no automatic retry" });
console.log("manual", (await s.compactNow("manual", agents.get("manual")!.revision)).status);
console.log("failed", (await s.compactNow("failed", agents.get("failed")!.revision)).status);
// The automatic reservation is due after the idle delay; keep the others in the future.
agents.delete("interrupted");
time += DEFAULT_SETTINGS.idleMinutes * 60_000;
await s.tick(true);
// A reservation that is still in the future.
agents.set("reserved", agent("reserved", 1)); await s.observedTurn(agents.get("reserved")!, time - 1000);
// Leave one manual request running, as a crash would.
agents.set("interrupted", agent("interrupted", 7));
void s.compactNow("interrupted", agents.get("interrupted")!.revision);
await new Promise(r => setTimeout(r, 200));
writeFileSync(out, readFileSync(path, "utf8"));
