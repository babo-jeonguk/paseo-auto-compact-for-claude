import { open } from 'node:fs/promises';

export type CacheSource = 'transcript' | 'settings' | 'environment' | 'default';
export interface CacheWindow {
  ttlMinutes: number;
  source: CacheSource;
  deadline: number;
  observedAt?: number;
  mixed?: boolean;
}
export interface CacheRequest {
  startedAt: number;
  model: string | null;
  policy: { ttl: '5m' | '1h' | null; source: 'settings' | 'environment' | 'default' };
}
interface Evidence { ttlMinutes: number; observedAt: number; mixed: boolean }

// Inspired by claude-cache's transcript approach. Keep metadata only, and stop
// at a compact boundary instead of inheriting a TTL from discarded context.
export function transcriptTtl(text: string, sessionId: string, model: string | null, now: number): Evidence | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (!row || row.isSidechain || (row.sessionId && row.sessionId !== sessionId)) continue;
    if (row.isCompactSummary || row.compactMetadata || row.subtype === 'compact_boundary') break;
    if (row.type !== 'assistant') continue;
    const message = row.message;
    if (model && message?.model !== model) continue;
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at) || at > now + 1000 || now - at > 3_600_000) continue;
    const creation = message?.usage?.cache_creation;
    const five = creation?.ephemeral_5m_input_tokens, hour = creation?.ephemeral_1h_input_tokens;
    if ((five !== undefined && (!Number.isSafeInteger(five) || five < 0)) ||
        (hour !== undefined && (!Number.isSafeInteger(hour) || hour < 0))) continue;
    if (five > 0 || hour > 0) return { ttlMinutes: five > 0 ? 5 : 60, observedAt: at, mixed: five > 0 && hour > 0 };
    // Read-only responses refresh a previously observed prefix. Continue to its
    // latest write in the same context/model; absence falls back to policy.
  }
  return null;
}

export function createCacheReader() {
  const files = new Map<string, { size: number; mtime: number; text: string }>();
  return async function cacheWindow(request: CacheRequest | null, transcriptPath: string | null,
    sessionId: string, endedAt: number | null, now: number): Promise<CacheWindow | null> {
    const startedAt = request?.startedAt ?? endedAt;
    if (startedAt === null || startedAt > now) return null;
    let evidence: Evidence | null = null;
    if (transcriptPath) {
      let file;
      try {
        file = await open(transcriptPath, 'r');
        const stat = await file.stat();
        if (stat.isFile()) {
          let cached = files.get(transcriptPath);
          if (!cached || cached.size !== stat.size || cached.mtime !== stat.mtimeMs) {
            const buffer = Buffer.alloc(Math.min(stat.size, 512 * 1024));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
            cached = { size: stat.size, mtime: stat.mtimeMs, text: buffer.subarray(0, bytesRead).toString('utf8') };
            // Bound memory even when many old sessions have been opened.
            if (files.size >= 64) files.delete(files.keys().next().value!);
            files.set(transcriptPath, cached);
          }
          evidence = transcriptTtl(cached.text, sessionId, request?.model ?? null, now);
        }
      } catch { /* Unsupported/missing transcript does not disable normal scheduling. */ }
      finally { await file?.close().catch(() => {}); }
    }
    const policy = request?.policy;
    // Current writes describe what happened. An explicit policy takes priority
    // over an old write when the latest request only reports cache reads.
    if (evidence && (evidence.observedAt >= startedAt - 1000 || !policy?.ttl)) {
      return { ...evidence, source: 'transcript', deadline: startedAt + evidence.ttlMinutes * 60_000 };
    }
    const ttlMinutes = policy?.ttl === '5m' ? 5 : 60;
    return { ttlMinutes, source: policy?.ttl ? policy.source : 'default', deadline: startedAt + ttlMinutes * 60_000 };
  };
}
