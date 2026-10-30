import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// All checkouts share one native-test slot on this machine. Do not wait for
// capacity while a daemon/emulator from another run competes for resources.
export async function acquireNativeSlot(directory = join(tmpdir(), 'auto-compact-native-test.lock')) {
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readFile(join(directory, 'owner.json'), 'utf8').catch(() => 'initializing');
    throw new Error(`Another native test owns ${directory}: ${owner}. Wait for it to finish. If it crashed, verify its PID has exited before removing this lock.`);
  }
  try {
    await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd() }));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(directory, { recursive: true, force: true });
}
