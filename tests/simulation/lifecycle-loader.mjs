// Test-only: accelerate the stock 0.14 cleanup sweep and its own clock only.
// The marker is created after an ordinary turn; no plugin clocks are changed.
import { readFile } from 'node:fs/promises';
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.includes('/agent/idle-runtime-cleanup/index.js')) return result;
  let source = result.source?.toString() ?? await readFile(new URL(url), 'utf8');
  const clock = 'const now = options.now ?? Date.now;';
  const timer = '}, 60000);';
  if (!source.includes(clock) || !source.includes(timer)) throw new Error('Unexpected Paseo cleanup module');
  source = `import { existsSync as lifecycleMarkerExists, statSync as lifecycleMarkerStat } from 'node:fs';\n` + source.replace(clock,
    "const now = options.now ?? (() => Date.now() + (lifecycleMarkerExists(process.env.LIFECYCLE_CLEANUP_MARKER) ? 7200000 + (Date.now() - lifecycleMarkerStat(process.env.LIFECYCLE_CLEANUP_MARKER).mtimeMs) * 7200 : 0));").replace(timer, '}, 500);');
  return { ...result, source };
}
