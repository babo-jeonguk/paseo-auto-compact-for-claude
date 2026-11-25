import type { State } from "./model";

// The conversations whose shown state differs between two saved states, or
// null when what was saved before is not known.
export function changedConversations(_before: State | null, _after: State): string[] | null {
  throw new Error("Not implemented");
}
