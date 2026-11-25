// A step the code under test waits on, held by the test: `pass` is the step,
// which resolves `reached` and then waits for `release`, so a test waits for the
// code to reach the step instead of guessing when it has.
export function gate() {
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { reach = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, pass: async () => { reach(); await released; } };
}
export type Gate = ReturnType<typeof gate>;
