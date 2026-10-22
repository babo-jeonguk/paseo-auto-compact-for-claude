import type { Row } from "../shared/rpc";

export const listKey = (hostId: string) => ["auto-compact", hostId] as const;
export const errorLabel = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const tokenLabel = (tokens: number) =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}m`
    : `${Math.round(tokens / 1000)}k`;
// Settings must keep every token when an existing value is opened and saved.
export function formatTokenThreshold(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const places = tokens >= 1_000_000 ? 6 : 3;
  const divisor = 10 ** places;
  const fraction = String(tokens % divisor)
    .padStart(places, "0")
    .replace(/0+$/, "");
  return `${Math.floor(tokens / divisor)}${fraction ? `.${fraction}` : ""}${
    places === 6 ? "m" : "k"
  }`;
}

export function parseTokenThreshold(input: string): number | null {
  const text = input.trim();
  if (text.length > 64) return null;
  const match = /^(\d+)(?:\.(\d+))?([km]?)$/i.exec(text);
  if (!match) return null;
  const [, whole, fraction = "", suffix] = match;
  if (!suffix && fraction) return null;
  const places = suffix.toLowerCase() === "m" ? 6 : suffix ? 3 : 0;
  // Shift decimal digits instead of multiplying floats (e.g. 1.001k).
  if (/[1-9]/.test(fraction.slice(places))) return null;
  const tokens = Number(whole + fraction.slice(0, places).padEnd(places, "0"));
  return Number.isSafeInteger(tokens) ? tokens : null;
}
export function canSkip(row: Row) {
  return (
    !!row.revision &&
    row.dueAt !== null &&
    ["scheduled", "blocked", "busy"].includes(row.status)
  );
}
