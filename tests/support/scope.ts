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
}

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
    async folder(prefix) {
      const folder = await mkdtemp(join(tmpdir(), prefix));
      // Retries give a Windows handle that closes late time to go.
      const remove = () => rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
      // A folder whose test ended while it was being created goes at once.
      if (ended) { await remove(); throw new Error("The test ended while its folder was being created"); }
      defer(remove);
      return folder;
    },
  };
  scopes.set(t, scope);
  return scope;
}
