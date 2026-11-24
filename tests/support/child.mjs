// A program the process-helper tests start, as a file so lint checks it like
// any other test code. Each line it prints is `<what> <value>`.
//
//   tree         makes a folder in the system temp directory, starts a
//                grandchild that shares its output, prints both PIDs and the
//                folder, and runs until it is killed
//   orphan       starts a grandchild that shares its output, prints both PIDs
//                and exits 0, leaving the grandchild holding the output open
//                where the platform lets it outlive its parent
//   exit <code>  prints `ran` and exits with that code
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A listening socket keeps the process running whatever happens to its input,
// which Node closes when the process that started it exits.
const stay = () => createServer().listen(0, '127.0.0.1');

const [mode, value] = process.argv.slice(2);
if (mode === 'exit') {
  console.log('ran');
  process.exit(Number(value));
} else if (mode === 'tree') {
  console.log(`folder ${await mkdtemp(join(tmpdir(), 'compact-child-made-'))}`);
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf'], { stdio: 'inherit', windowsHide: true });
  console.log(`child ${process.pid}`);
  stay();
} else if (mode === 'orphan') {
  // Exits once the grandchild has printed its PID, so the test sees both.
  const leaf = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf'],
    { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  leaf.once('message', () => {
    console.log(`child ${process.pid}`);
    process.exit(0);
  });
} else if (mode === 'leaf') {
  console.log(`grandchild ${process.pid}`);
  process.send?.('ready');
  stay();
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
