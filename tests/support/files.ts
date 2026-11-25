import * as fs from "node:fs/promises";
import { gate, type Gate } from "./gate";
import type { DurableFiles } from "../../server/durable";

// The file operations durable writes use, on the real file system, with steps
// a test can hold. `holdWrite(target)` holds the next write of a temporary
// file for `target` before it starts, so its publication has not been issued
// yet; `holdRename(target)` holds the next rename onto `target` once it has
// been called, as a rename the OS has not finished, and `landed` resolves once
// the real rename has. Each hold is used once; holds on different targets are
// independent, so a test can hold several files at the same time.
export function heldFiles() {
  const writes = new Map<string, Gate>();
  const renames = new Map<string, { held: Gate; landed: () => void }>();
  const files: DurableFiles = {
    writeFile: (async (path: string, ...rest: unknown[]) => {
      const target = [...writes.keys()].find(target => path.startsWith(target + "."));
      if (target !== undefined) {
        const held = writes.get(target)!;
        writes.delete(target);
        await held.pass();
      }
      return (fs.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
    }) as DurableFiles["writeFile"],
    rename: async (from, to) => {
      const hold = renames.get(String(to));
      if (hold) {
        renames.delete(String(to));
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
      writes.set(target, held);
      return held;
    },
    holdRename(target: string) {
      const held = gate();
      let landed!: () => void;
      const done = new Promise<void>(resolve => { landed = resolve; });
      renames.set(target, { held, landed });
      return { ...held, landed: done };
    },
  };
}
