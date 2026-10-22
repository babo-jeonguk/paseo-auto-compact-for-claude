import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import contribute from "../index.server";

type Before = (input: { request: PluginSessionOpenRequest }, context: unknown) => Promise<PluginSessionOpenRequest>;

test("plugin state or observer failures cannot prevent a Claude session from opening", async () => {
  const home = await mkdtemp(join(tmpdir(), "compact-session-open-"));
  const previous = process.env.PASEO_HOME;
  const errors = console.error;
  process.env.PASEO_HOME = home;
  console.error = () => {};
  let open: Before | undefined;
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "loading" }), subscribe: () => () => {} }),
    on: () => () => {},
    before: (name: string, handler: Before) => {
      if (name === "agent.session_open") open = handler;
      return () => {};
    },
    handle: () => {},
  } as unknown as PluginServerContext;
  const data = join(home, "plugin-data", "auto-compact-for-claude");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "state.json"), "{ corrupt");
  const dispose = contribute(server);
  try {
    const request: PluginSessionOpenRequest = { agentId: "a", workspaceId: "w", provider: "claude",
      purpose: "interactive", reason: "create", cwd: home, env: { CLAUDE_CODE_PLUGIN_DIRS: "/existing" } };
    const paseo = { config: { get: async () => ({ config: { providers: {} } }) } };
    const opened = await open!({ request }, { paseo });
    const dirs = opened.env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter);
    assert.equal(dirs[0], "/existing");
    assert.match(dirs[1], /observers/);
    // An observer that cannot be written leaves the session unchanged rather than closed.
    await rm(join(data, "observers"), { recursive: true });
    await writeFile(join(data, "observers"), "not a directory");
    assert.deepEqual(await open!({ request }, { paseo }), request);
  } finally {
    dispose();
    console.error = errors;
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
