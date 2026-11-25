import * as fs from "node:fs/promises";
import { gate, type Gate } from "./gate";
import type { DurableFiles } from "../../server/durable";

// The file operations durable writes use, on the real file system, with one
// step a test can hold. `holdWrite(target)` holds the next write of a
// temporary file for `target` before it starts, so its publication has not
// been issued yet; `holdRename(target)` holds the next rename onto `target`
// once it has been called, as a rename the OS has not finished, and `landed`
// resolves once the real rename has. Each hold is used once.
export function heldFiles() {
  let write: { target: string; held: Gate } | null = null;
  let rename: { target: string; held: Gate; landed: () => void } | null = null;
  const files: DurableFiles = {
    writeFile: (async (path: string, ...rest: unknown[]) => {
      const hold = write;
      if (hold && path.startsWith(hold.target + ".")) {
        write = null;
        await hold.held.pass();
      }
      return (fs.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
    }) as DurableFiles["writeFile"],
    rename: async (from, to) => {
      const hold = rename;
      if (hold && to === hold.target) {
        rename = null;
        await hold.held.pass();
        try { return await fs.rename(from, to); } finally { hold.landed(); }
      }
      return fs.rename(from, to);
    },
    rm: fs.rm,
  };
  return {
    files,
    holdWrite(target: string) {
      const held = gate();
      write = { target, held };
      return held;
    },
    holdRename(target: string) {
      const held = gate();
      let landed!: () => void;
      const done = new Promise<void>(resolve => { landed = resolve; });
      rename = { target, held, landed };
      return { ...held, landed: done };
    },
  };
}
