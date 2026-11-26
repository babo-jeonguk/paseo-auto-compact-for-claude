import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Stopped } from "./deadline";
import { createGroup } from "./group";

// The file operations durable writes use; tests pass ones they can hold.
export type DurableFiles = Pick<typeof fs, "writeFile" | "rename" | "rm">;
export type DurableWrites = {
  run<T>(work: () => Promise<T>): Promise<T>;
  replace(path: string, contents: string): Promise<void>;
  // Closes the writes, and hands every failure of a write still in flight to
  // `teardown` as it settles (its caller still gets it too).
  close(teardown: (error: unknown) => void): void;
  drain(): Promise<void>;
};

export function createDurableWrites(files: DurableFiles = fs): DurableWrites {
  // The plugin's cleanup closes then drains, and Paseo awaits that cleanup
  // before it closes the plugin process and starts the replacement (it sends
  // SIGTERM 2 s after asking to stop, SIGKILL 2 s later). Draining the writes
  // already issued makes them land before the next instance starts, while a
  // publication that was never issued never happens at all.
  const group = createGroup();
  // Set by close; a non-null owner is the fence. It is the plugin's reporter,
  // which logs a failure handed over by several nested writes once.
  let teardown: ((error: unknown) => void) | null = null;
  // Read through a call: a check before an await must not narrow the owner
  // for the code after it, where close may have set it.
  const closed = () => teardown !== null;
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    // A closed lifetime admits nothing new, and touches no file.
    if (closed()) throw new Stopped();
    try {
      return await group.track(work());
    } catch (error) {
      // A write issued before close may settle after it: its caller still gets
      // the failure, and the teardown owner sees it too.
      if (teardown) teardown(error);
      throw error;
    }
  };
  const replace = (path: string, contents: string) => run(async () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let publication: { error: unknown } | null = null;
    try {
      await files.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
      // Fence: a publication whose rename was not issued before close stays
      // unpublished, and the file keeps what the last landed write left.
      if (teardown) throw new Stopped();
      await files.rename(temporary, path);
    } catch (error) {
      publication = { error };
    }
    // Remove the temporary file after either outcome, without letting a failed
    // removal replace the failure that came first.
    let cleanup: { error: unknown } | null = null;
    try {
      await files.rm(temporary, { force: true });
    } catch (error) {
      cleanup = { error };
    }
    if (publication && cleanup)
      throw new AggregateError([publication.error, cleanup.error],
        "Durable replacement failed and its temporary file could not be removed");
    if (publication) throw publication.error;
    if (cleanup) throw cleanup.error;
  });
  return {
    run,
    replace,
    close(owner) { teardown = owner; },
    async drain() {
      // Work tracked while draining is drained too: idle waits for the count to
      // reach 0; a replacement can start no work once closed, but run() may
      // already have been called.
      await group.idle();
    },
  };
}
