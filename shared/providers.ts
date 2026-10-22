export function claudeProvider(
  providers: Record<string, unknown>,
  provider: string
): boolean {
  const visited = new Set<string>();
  let id = provider;
  while (!visited.has(id)) {
    visited.add(id);
    const parent = (providers[id] as { extends?: string } | undefined)?.extends;
    if (!parent) return id === "claude";
    id = parent;
  }
  return false;
}
