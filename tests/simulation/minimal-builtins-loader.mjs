// Optional test isolation for a heavily loaded machine. Preserve the released
// server and plugin runtime; omit only unrelated bundled provider/usage plugins.
// This is not evidence for the complete default bundled-plugin configuration.
import { readFile } from 'node:fs/promises';
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/plugins/builtin/index.js')) return result;
  const source = result.source?.toString() ?? await readFile(new URL(url), 'utf8');
  const minimal = source.replace(/export const builtinPlugins = \[[\s\S]*?\];/, 'export const builtinPlugins = [];');
  if (minimal === source) throw new Error('Unexpected Paseo bundled-plugin list; cannot isolate test startup');
  return { ...result, source: minimal };
}
