// A test file the cleanup-scope tests run under `node --test` with a short
// --test-timeout. Its one test acquires what unit tests do (an observer's
// folder, a store's folder and the scheduler writing to it, a child process
// with a grandchild), prints the PIDs of that process tree, and then waits
// until the runner's bound stops it. Only the scope's release can then let the
// run exit and leave its temp directory empty.
import { test } from "node:test";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { createObserver } from "../../server/observer";
import { createScheduler } from "../../server/scheduler";
import { createStore } from "../../server/store";
import { DEFAULT_SETTINGS } from "../../shared/settings";
import { cleanupScope } from "./scope";

// Longer than the runner's bound, so the bound, not the child's own limit,
// is what stops the test.
const CHILD_MS = 60_000;

test("holds what a unit test acquires until the runner's bound stops it", async (t) => {
  const scope = cleanupScope(t);
  const home = await scope.folder("compact-bound-observer-");
  await createObserver({ home }).prepareSession({
    agentId: "a", workspaceId: "w", provider: "claude", purpose: "interactive", reason: "create",
    cwd: home, title: "Conversation", labels: {}, metadata: {}, background: false, tools: [], mcpServers: {}, env: {},
  } as PluginSessionOpenRequest, true);
  const store = createStore(join(await scope.folder("compact-bound-store-"), "state.json"));
  const scheduler = createScheduler({
    store, settings: async () => ({ ...DEFAULT_SETTINGS, enabled: false }),
    gateway: { list: async () => {}, refresh: async () => null, compact: async () => ({ status: "completed", detail: "" }) },
  });
  scope.defer(() => scheduler.stop());
  await scheduler.ready;
  const child = await scope.spawn(process.execPath, [fileURLToPath(new URL("./child.mjs", import.meta.url)), "tree"],
    { timeout: CHILD_MS });
  const pids: string[] = [];
  for await (const line of createInterface({ input: child.stdout! })) {
    const [name, value] = line.split(" ");
    if (name === "child" || name === "grandchild") pids.push(value);
    if (pids.length === 2) break;
  }
  console.log(`holding ${pids.join(" ")}`);
  await new Promise(() => {});
});
