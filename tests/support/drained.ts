// A unit test's code under test waits only on its fakes and injected timers
// (lint keeps real timers out of server/ and shared/), so once the callbacks
// queued now have run, nothing more happens until the test acts: a held step
// is released, a fake timer is moved on. The `drained()` that `drainer()`
// returns resolves after one event-loop turn and checks what Node lists as
// still pending: it fails on a timer, an immediate or an I/O request, or on more
// handles of a kind (a socket, a child process) than were open as the fixture
// started, since work outside the test's control could then act after the
// check. A check that something did not happen while a step is held asserts
// after it.
//
// Node lists neither unref'd timers nor thread-pool work such as compression,
// and counts handles only by kind, so one closed and another opened looks the
// same. Injected timers keep the first out; code under test that does the rest
// is checked after the promise of its call instead.
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
