import * as fs from "node:fs/promises";

// The file operations durable writes use; tests pass ones they can hold.
export type DurableFiles = Pick<typeof fs, "writeFile" | "rename" | "rm">;
export type DurableWrites = {
  run<T>(work: () => Promise<T>): Promise<T>;
  replace(path: string, contents: string): Promise<void>;
  close(): void;
  drain(): Promise<void>;
};

export function createDurableWrites(files: DurableFiles = fs): DurableWrites {
  void files;
  throw new Error("Not implemented");
}
