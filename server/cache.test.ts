import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCacheReader, transcriptTtl, type CacheRequest } from './cache';

const now = Date.parse('2026-10-22T00:00:00Z');
const row = (five: number, hour: number, extra = {}) => JSON.stringify({
  type: 'assistant', sessionId: 'session', timestamp: new Date(now).toISOString(),
  message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 18,
    cache_read_input_tokens: 100, cache_creation_input_tokens: five + hour,
    cache_creation: { ephemeral_1h_input_tokens: hour, ephemeral_5m_input_tokens: five } } }, ...extra,
}) + '\n';
const request: CacheRequest = { startedAt: now - 100, model: 'claude-sonnet-4-6',
  policy: { ttl: null, source: 'default' } };

test('native transcript usage with cache reads still provides one-hour TTL; mixed writes use the shorter TTL', () => {
  assert.equal(transcriptTtl(row(0, 10), 'session', request.model, now)?.ttlMinutes, 60);
  assert.equal(transcriptTtl(row(10, 0), 'session', request.model, now)?.ttlMinutes, 5);
  const mixed = transcriptTtl(row(1, 10), 'session', request.model, now);
  assert.equal(mixed?.ttlMinutes, 5); assert.equal(mixed?.mixed, true);
});

test('transcript parsing excludes other sessions, sidechains, old context and malformed partial tails', () => {
  assert.equal(transcriptTtl(row(0, 10, { sessionId: 'other' }), 'session', request.model, now), null);
  assert.equal(transcriptTtl(row(0, 10, { isSidechain: true }), 'session', request.model, now), null);
  assert.equal(transcriptTtl(row(0, 10), 'session', 'other-model', now), null);
  assert.equal(transcriptTtl(row(0, 10, { timestamp: new Date(now - 3_600_001).toISOString() }), 'session', request.model, now), null);
  assert.equal(transcriptTtl(row(0, 10) + '{"type":"system","subtype":"compact_boundary"}\n', 'session', request.model, now), null);
  assert.equal(transcriptTtl('partial row\n' + row(0, 10) + '{incomplete', 'session', request.model, now)?.ttlMinutes, 60);
});

test('missing TTL uses a disclosed one-hour default; settings and actual transcript override it without blocking 50/55m', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compact-ttl-'));
  try {
    const path = join(dir, 'session.jsonl'), read = createCacheReader();
    const fallback = await read(request, path, 'session', now, now);
    assert.equal(fallback?.source, 'default'); assert.equal(fallback?.ttlMinutes, 60);
    for (const delay of [50, 55]) assert(fallback!.deadline > now + delay * 60_000 + 30_000);
    await writeFile(path, row(0, 10));
    const observed = await read(request, path, 'session', now, now);
    assert.equal(observed?.source, 'transcript'); assert.equal(observed?.ttlMinutes, 60);
    // Re-read changed metadata even after a previous one-hour observation.
    // Same-size rewrites can share an mtime tick on Windows.
    await writeFile(path, row(12, 0));
    await utimes(path, new Date(now + 1_000), new Date(now + 1_000));
    assert.equal((await read(request, path, 'session', now, now))?.ttlMinutes, 5);
    assert.equal((await read({ ...request, policy: { ttl: '5m', source: 'settings' } }, null, 'session', now, now))?.source, 'settings');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('read-only replies refresh a recent same-model observation; explicit changed policy overrides an old write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compact-ttl-read-'));
  try {
    const path = join(dir, 'session.jsonl'), read = createCacheReader();
    await writeFile(path, row(0, 10) + row(0, 0, { timestamp: new Date(now + 60_000).toISOString() }));
    const later = { ...request, startedAt: now + 59_000 };
    const inherited = await read(later, path, 'session', now + 60_000, now + 60_000);
    assert.equal(inherited?.source, 'transcript');
    assert.equal(inherited?.deadline, later.startedAt + 3_600_000);
    const changed = await read({ ...later, policy: { ttl: '5m', source: 'environment' } }, path, 'session', now + 60_000, now + 60_000);
    assert.equal(changed?.source, 'environment'); assert.equal(changed?.ttlMinutes, 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
