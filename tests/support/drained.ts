// A unit test's code under test waits only on its fakes and injected timers
// (lint keeps real timers out of server/ and shared/), so once every queued
// callback has run, nothing more happens until the test acts: a held step is
// released, a fake timer is moved on. The `drained()` that `drainer()` returns
// resolves at that point. It fails if a real timer, immediate or I/O request is
// still pending, or a handle (a socket, a child process) opened since the
// fixture started is still open, since work outside the test's control could
// then act after the check. A check that something did not happen while a step
// is held asserts after it.
//
// Node lists only work that keeps the process alive, so an unref'd timer is
// not seen here; injecting timers is what keeps those out.
export function drainer() {
  // Handles the runner and the process already hold, such as the runner's pipes.
  const baseline = pendingByType();
  return async function drained(): Promise<void> {
    // An immediate runs once the queued callbacks before it have run.
    await new Promise<void>(resolve => setImmediate(resolve));
    const pending = [...pendingByType()].flatMap(([type, count]) => {
      // A timer, an immediate or a request ends on its own, so one pending now
      // is still to run, whatever was pending as the fixture started.
      const extra = transient(type) ? count : count - (baseline.get(type) ?? 0);
      return extra > 0 ? [`${type} x${extra}`] : [];
    });
    if (pending.length)
      throw new Error(`Work outside the test's control is still pending: ${pending.join(", ")}`);
  };
}

const transient = (type: string) => type === "Timeout" || type === "Immediate" || type.includes("Req");

function pendingByType() {
  const counts = new Map<string, number>();
  for (const type of process.getActiveResourcesInfo()) counts.set(type, (counts.get(type) ?? 0) + 1);
  return counts;
}
