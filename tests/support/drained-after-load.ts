// A unit test the loader test runs in a child process, through the unit-test
// scripts' own loader, with a temp directory no earlier run has used, so the
// TypeScript loader compiles every file afresh. It loads a module the process
// has not compiled yet and then checks that nothing is pending: a loader that
// caches what it compiles would still be writing that cache, which drained()
// reports.
import { test } from "node:test";
import { drainer } from "./drained";

test("nothing is pending after a TypeScript module is compiled", async () => {
  const drained = drainer();
  await import("../../server/deadline");
  await drained();
});
