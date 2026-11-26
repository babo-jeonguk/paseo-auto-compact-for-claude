// Work in flight that a caller must later wait for.
export function createGroup(): {
  track<T>(work: Promise<T>): Promise<T>;
  idle(): Promise<void>;
  busy(): boolean;
} {
  throw new Error("not implemented");
}
