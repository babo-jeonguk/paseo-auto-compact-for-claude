import { spawn as start, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What the scope needs from a test context; the runner's TestContext has both.
export interface ScopeContext {
  after(hook: () => unknown): void;
  diagnostic(message: string): void;
}

export interface CleanupScope {
  // Registers a release to run when the test ends.
  defer(release: () => unknown): void;
  // Creates a folder under the system temp directory and registers its removal
  // in the same call, so no step between the two can leak it.
  folder(prefix: string): Promise<string>;
  // Starts a child process the test owns: its temp directory (TMPDIR, TMP and
  // TEMP) is a folder of the test's, given as `temp`, so whatever the child
  // and its descendants create there goes when the test ends, and its whole
  // process tree ends then too. `timeout` bounds a hung child: when it passes
  // before every process holding the child's output has exited, the tree ends
  // and `timedOut` is set. Options are spawn()'s.
  spawn(command: string, args: readonly string[], options: ChildOptions): Promise<Child>;
  // Runs a child as spawn() does and collects its output, like execFile:
  // resolves on exit code 0 within the time limit, and otherwise rejects with
  // `code`, `signal`, `timedOut`, `stdout` and `stderr` on the error. Both
  // carry the child's `temp`.
  run(command: string, args: readonly string[], options: Omit<ChildOptions, "stdio">): Promise<Output>;
}

export type ChildOptions = Omit<SpawnOptions, "timeout" | "detached"> & { timeout: number };
export type Child = ChildProcess & { temp: string; timedOut: boolean };
// What run() collected from a child that exited 0, and the child's temp folder.
export interface Output { stdout: string; stderr: string; temp: string }

// Removal retries, so a file a Windows process held until it was ended has
// time to be released: up to 10 tries 20 ms apart, well past how long a killed
// process takes to close its handles.
const REMOVE_RETRIES = 10;
const REMOVE_RETRY_DELAY_MS = 20;
// How long taskkill may take to end a tree: it normally returns within a
// second, so this bounds only a taskkill that hangs.
const TASKKILL_MS = 10_000;

// A tree end that failed at a child's time limit, for run() to fail with.
const limitFailures = new WeakMap<ChildProcess, Promise<never>>();

const scopes = new WeakMap<ScopeContext, CleanupScope>();

// A unit test's one cleanup scope. Whatever acquires something that would
// outlive the test (a temporary folder, a started gateway, scheduler or
// observer, a changed environment variable) registers its release here as it
// acquires it, inside the fixture that acquires it. When the test ends,
// however it ends (passing, failing, or stopped at the runner's bound), the
// scope releases everything in reverse order of acquisition, so what was
// started on a folder stops before the folder goes. A release that fails does
// not stop the rest, and every failure is reported.
//
// The platform's AsyncDisposableStack has this contract, but its type
// declarations conflict with React Native's global URL type, so the scope
// keeps the list itself. It registers the test's only t.after() hook; a
// fixture and its caller given the same context share one scope.
export function cleanupScope(t: ScopeContext): CleanupScope {
  const existing = scopes.get(t);
  if (existing) return existing;
  const releases: (() => unknown)[] = [];
  let ended = false;
  t.after(async () => {
    ended = true;
    const failures: unknown[] = [];
    for (const release of releases.reverse()) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 0) return;
    // The runner reports only the test's own error when the test failed too,
    // so each cleanup failure is also printed under the test.
    for (const failure of failures)
      t.diagnostic(`cleanup failed: ${failure instanceof Error ? failure.stack : String(failure)}`);
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, `${failures.length} cleanup steps failed`);
  });
  const defer = (release: () => unknown) => {
    if (ended) throw new Error("The test has ended: release what it acquired now instead of deferring it");
    releases.push(release);
  };
  const scope: CleanupScope = {
    defer,
    async spawn(command, args, { timeout, env = process.env, ...options }) {
      // An IPC channel is not a pipe the scope can close when it cannot reach
      // a process holding it, and no test needs one.
      if ([options.stdio].flat().includes("ipc")) throw new Error("A child started through the scope takes no IPC channel");
      // Acquired first, so it goes only once the tree has ended.
      const temp = await scope.folder("compact-child-");
      const child = Object.assign(start(command, args, {
        windowsHide: true, ...options,
        // Its own process group on POSIX, so the group can be signalled.
        detached: process.platform !== "win32",
        env: { ...env, TMPDIR: temp, TMP: temp, TEMP: temp },
      }), { temp, timedOut: false });
      // A child that never started has no process to wait for.
      const exited = new Promise<void>(resolve => {
        child.once("exit", () => resolve());
        child.once("error", () => { if (child.pid === undefined) resolve(); });
      });
      // Every stream closes once each process holding it has exited, or once
      // it is destroyed here.
      const closed = new Promise<void>(resolve => {
        child.once("close", () => resolve());
        child.once("error", () => { if (child.pid === undefined) resolve(); });
      });
      // Ends the tree once, at the limit or when the test ends, whichever
      // comes first. A descendant the tree end could not reach would hold the
      // child's pipes open, so the scope closes its ends instead of waiting.
      let ending: Promise<void> | undefined;
      const close = () => { for (const pipe of child.stdio) pipe?.destroy(); };
      const end = () => ending ??= (async () => {
        let reached;
        // A tree that cannot be ended still leaves the scope's own pipe ends
        // to close, so they do not keep the test's process running.
        try { reached = endTree(child); } catch (error) { close(); throw error; }
        await exited;
        if (!reached) close();
      })();
      // The limit holds until the output closes, not only until the child
      // exits: a descendant left holding it is the hang it bounds. A tree it
      // cannot end fails run() at once and is reported again by the release.
      let failAtLimit!: (error: unknown) => void;
      const limitFailure = new Promise<never>((_, reject) => { failAtLimit = reject; });
      limitFailure.catch(() => {}); // a spawn() caller learns of it from the release
      limitFailures.set(child, limitFailure);
      // eslint-disable-next-line no-restricted-syntax -- the time limit a real process keeps (CODING_STANDARDS.md "Tests"); spawn's own would end only the direct child
      const limit = setTimeout(() => { child.timedOut = true; end().catch(failAtLimit); }, timeout);
      void closed.then(() => clearTimeout(limit));
      defer(async () => {
        clearTimeout(limit);
        // Output nobody reads any more is dropped, so the streams can end.
        child.stdout?.resume();
        child.stderr?.resume();
        await end();
        await closed;
      });
      return child;
    },
    async run(command, args, options) {
      const child = await scope.spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      // Ends when the output closes, or at once when the time limit could not
      // end the tree, which leaves the output open.
      const ended = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once("error", error => reject(Object.assign(error, { temp: child.temp })));
          child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
        }),
        limitFailures.get(child)!.catch((cause: unknown) => ({ code: child.exitCode, signal: child.signalCode, cause })),
      ]);
      const { code, signal } = ended;
      if (code === 0 && !child.timedOut) return { stdout, stderr, temp: child.temp };
      const failure = !child.timedOut ? "failed"
        : `timed out after ${options.timeout} ms${"cause" in ended ? " and its process tree could not be ended" : ""}`;
      throw Object.assign(new Error(`Command ${failure}: ${[command, ...args].join(" ")}\n${stderr}`,
        "cause" in ended ? { cause: ended.cause } : undefined),
        { code, signal, timedOut: child.timedOut, stdout, stderr, temp: child.temp });
    },
    async folder(prefix) {
      const folder = await mkdtemp(join(tmpdir(), prefix));
      // Retries give a Windows handle that closes late time to go.
      const remove = () => rm(folder, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_RETRY_DELAY_MS });
      // A folder whose test ended while it was being created goes at once.
      if (ended) { await remove(); throw new Error("The test ended while its folder was being created"); }
      defer(remove);
      return folder;
    },
  };
  scopes.set(t, scope);
  return scope;
}

// Ends a child's process tree, and says whether that reached every process in
// it. On POSIX the child leads its own process group, which outlives the
// child while any descendant is alive, so signalling the group reaches them
// even after the child itself has exited (a descendant that left the group
// for one of its own is neither reached nor detected; nor can the scope tell a
// group that has ended from a new one that took its ID, which needs another
// process to start its own group with that ID first). Windows has no such group: the tree is ended through the child
// while it still runs. A child that has exited is not signalled, since its PID
// may belong to another process by then; Node usually ends a Node child's own
// children with it on Windows, but another program's descendants (such as a
// command npm starts through cmd.exe) can be left, unreached.
function endTree(child: ChildProcess): boolean {
  if (child.pid === undefined) return true;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; // nothing left in the group
    }
    return true;
  }
  if (child.exitCode !== null || child.signalCode !== null) return false;
  // Synchronous, so Node keeps the child's process handle open throughout and
  // its PID cannot pass to another process before taskkill looks it up.
  const ended = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"],
    { windowsHide: true, encoding: "utf8", timeout: TASKKILL_MS });
  if (ended.status === 0) return true;
  // taskkill ran, but the child exited on its own before it reached it: still
  // our child's PID, since its handle is still open, and no longer running.
  // A taskkill that could not start or timed out is reported either way.
  if (!ended.error) {
    try { process.kill(child.pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    }
  }
  throw ended.error ?? new Error(`taskkill could not end process tree ${child.pid} (exit ${ended.status}): ${ended.stderr}`);
}
