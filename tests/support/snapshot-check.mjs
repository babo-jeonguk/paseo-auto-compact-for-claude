// The check the snapshot test commits to its fixture repository as
// `check.mjs`, which the snapshot wrapper runs (through npm) in its worktree.
// It prints that it started, then waits for the test's go-ahead: a line on
// its input, which the wrapper and npm pass on, sent once the test has
// advanced the original repository. It then exits 7 if it reads the
// snapshot's value and 2 otherwise, including when its input ends first, so
// the wrapper fails either way and the test tells the two apart.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

console.log('snapshot check started');
let ready = false;
for await (const line of createInterface({ input: process.stdin })) {
  ready = line === 'continue';
  break;
}
process.exit(ready && await readFile('value', 'utf8') === 'before' ? 7 : 2);
