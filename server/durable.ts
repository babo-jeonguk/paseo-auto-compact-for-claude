import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Stopped } from "./deadline";

// The file operations durable writes use; tests pass ones they can hold.
export type DurableFiles = Pick<typeof fs, "writeFile" | "rename" | "rm">;
export type DurableWrites = {
  run<T>(work: () => Promise<T>): Promise<T>;
  replace(path: string, contents: string): Promise<void>;
  close(): void;
  drain(): Promise<void>;
};

export function createDurableWrites(files: DurableFiles = fs): DurableWrites {
  // The plugin's cleanup closes then drains, and Paseo awaits that cleanup
  // before it closes the plugin process and starts the replacement (it sends
  // SIGTERM 2 s after asking to stop, SIGKILL 2 s later). Draining the writes
  // already issued makes them land before the next instance starts, while a
  // publication that was never issued never happens at all.
  const tracked = new Set<Promise<unknown>>();
  let closed = false;
  const track = <T>(work: Promise<T>): Promise<T> => {
    // Tracked until it settles, not until anyone stops waiting on it.
    const settled = work.then(() => undefined, () => undefined);
    tracked.add(settled);
    void settled.then(() => { tracked.delete(settled); });
    return work;
  };
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    // A closed lifetime admits nothing new, and touches no file.
    if (closed) throw new Stopped();
    return track(work());
  };
  const replace = (path: string, contents: string) => run(async () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await files.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
      // Fence: a publication whose rename was not issued before close stays
      // unpublished, and the file keeps what the last landed write left.
      if (closed) throw new Stopped();
      await files.rename(temporary, path);
    } finally {
      await files.rm(temporary, { force: true });
    }
  });
  return {
    run,
    replace,
    close() { closed = true; },
    async drain() {
      // Work tracked while draining is drained too; a replacement can start no
      // work once closed, but run() may already have been called.
      while (tracked.size) await Promise.all([...tracked]);
    },
  };
}
