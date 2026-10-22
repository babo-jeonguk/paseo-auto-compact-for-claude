import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join, delimiter, sep } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { observerAsset } from './observer-assets.generated';
import type { Observation } from './model';
import { createCacheReader } from './cache';

const LedgerSchema = z.object({
  version: z.literal(1), launchId: z.string(), generation: z.string(),
  sessionId: z.string().nullable(), updatedAt: z.number().finite(), revision: z.number().int().nonnegative(),
  activeTurns: z.array(z.string()), pendingInputs: z.number().int().nonnegative(),
  ordinaryEndedAt: z.number().finite().nullable(), ordinaryRevision: z.number().int().nullable(),
  cacheRequest: z.object({ startedAt: z.number().finite(), model: z.string().nullable(),
    policy: z.object({ ttl: z.enum(['5m', '1h']).nullable(),
      source: z.enum(['settings', 'environment', 'default']) }) }).nullable().default(null),
  transcriptPath: z.string().nullable().default(null), clockEpoch: z.number().int().default(0),
  closed: z.boolean(),
  compact: z.object({ id: z.string().nullable(), status: z.enum(['running', 'completed', 'failed', 'unknown']),
    revision: z.number().int(), reason: z.string().nullable().optional() }).nullable(),
});
type Ledger = z.infer<typeof LedgerSchema> & { cache: Awaited<ReturnType<ReturnType<typeof createCacheReader>>>;
  cacheDeadline: number | null };
const ManifestSchema = z.object({ launchId: z.string().uuid(), build: z.string() });
// The input-counting and command-guard fixes keep the same ledger and
// reservation contract. Keep already-open sessions observable until reopen.
const compatibleBuilds = new Set([observerAsset.version,
  'af6c6639f8c3058a73d5e982e308b69f5572fc6439a0c8fea61c1ca629ef4239',
  '8a6c0217779bc4f83c7029c8170c35da8d2ed8028622019f4a09808491dff90f',
  '7d9c570c36bcad4db9ef816c0b704c5b0d01d12c7522b215cdfbbfc160c86648']);

export function createObserver(options: { home?: string; now?: () => number } = {}) {
  const base = join(options.home ?? process.env.PASEO_HOME ?? join(homedir(), '.paseo'),
    'plugin-data', 'auto-compact-for-claude', 'observers');
  const now = options.now ?? Date.now;
  const cacheWindow = createCacheReader();
  const agentDirectory = (id: string) => join(base, createHash('sha256').update(id).digest('hex'));
  const atomic = async (path: string, value: unknown) => {
    const temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  };
  async function read(agentId: string): Promise<{ ledger: Ledger; directory: string } | null> {
    try {
      const parent = agentDirectory(agentId);
      const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(parent, 'current.json'), 'utf8')));
      if (!compatibleBuilds.has(manifest.build)) return null;
      const directory = join(parent, manifest.launchId);
      const path = join(directory, 'ledger.json');
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768) return null;
      const ledger = LedgerSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (ledger.launchId !== manifest.launchId || ledger.closed ||
          now() < ledger.updatedAt || now() - ledger.updatedAt > 60_000) return null;
      const cache = await cacheWindow(ledger.cacheRequest, ledger.transcriptPath,
        ledger.sessionId ?? '', ledger.ordinaryEndedAt, now());
      return { ledger: { ...ledger, cache, cacheDeadline: cache?.deadline ?? null }, directory };
    } catch { return null; }
  }
  function reason(ledger: Ledger | undefined, agent: Observation, dueAt = now()) {
    if (!ledger || ledger.sessionId !== agent.sessionId)
      return 'Claude observer unavailable; start a new conversation session';
    if (ledger.activeTurns.length || ledger.pendingInputs || ledger.compact?.status === 'running')
      return 'Claude is still working';
    if (ledger.cacheDeadline === null) return 'Waiting for an ordinary reply';
    if (now() >= ledger.cacheDeadline - 30_000) return 'Cache window passed';
    if (dueAt >= ledger.cacheDeadline - 30_000) return `Idle delay exceeds the ${ledger.cache?.ttlMinutes}-minute cache window (${ledger.cache?.source})`;
    return null;
  }
  return {
    read,
    async prepareSession(request: PluginSessionOpenRequest, eligible: boolean) {
      if (!eligible || request.purpose !== 'interactive') return request;
      const parent = agentDirectory(request.agentId), launchId = randomUUID();
      const directory = join(parent, launchId), mod = join(directory, 'mod');
      await mkdir(join(mod, '.claude-plugin'), { recursive: true, mode: 0o700 });
      await mkdir(join(mod, 'hooks'), { recursive: true, mode: 0o700 });
      const configuration = { launchId, ledger: join(directory, 'ledger.json'), request: join(directory, 'request.json') };
      await writeFile(configuration.ledger, '{}', { mode: 0o600, flag: 'wx' });
      await writeFile(configuration.request, '{}', { mode: 0o600, flag: 'wx' });
      await writeFile(join(mod, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'paseo-auto-compact-observer', version: '1.0.0',
        description: 'Observe conversation activity and compaction for Paseo Auto Compact' }), { mode: 0o600 });
      await writeFile(join(mod, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.mjs'] }), { mode: 0o600 });
      await writeFile(join(mod, 'hooks', 'register.mjs'), observerAsset.source + '\nexport function register(on) { registerObserver(on, ' +
        JSON.stringify(configuration) + '); }\n', { mode: 0o600 });
      await atomic(join(parent, 'current.json'), { launchId, build: observerAsset.version });
      const existing = request.env.CLAUDE_CODE_PLUGIN_DIRS?.split(delimiter)
        .filter(path => path && !path.startsWith(parent + sep));
      return { ...request, env: { ...request.env,
        CLAUDE_CODE_PLUGIN_DIRS: [...(existing ?? []), mod].join(delimiter) } };
    },
    async readiness(agent: Observation, dueAt?: number) {
      return reason((await read(agent.agentId))?.ledger, agent, dueAt);
    },
    async prepare(agent: Observation, requireCache: boolean, expiresAt: number) {
      const current = await read(agent.agentId);
      if (!current || current.ledger.sessionId !== agent.sessionId) throw new Error('Claude observer unavailable');
      const { ledger, directory } = current;
      if (ledger.activeTurns.length || ledger.pendingInputs || ledger.compact?.status === 'running')
        throw new Error('Claude is still working');
      if (requireCache) { const blocked = reason(ledger, agent); if (blocked) throw new Error(blocked); }
      const request = { id: randomUUID(), launchId: ledger.launchId, generation: ledger.generation,
        sessionId: ledger.sessionId, revision: ledger.revision, preparedAt: now(), expiresAt,
        requireCache, cacheDeadline: ledger.cacheDeadline, clockEpoch: ledger.clockEpoch, status: 'prepared' };
      await atomic(join(directory, 'request.json'), request);
      return { ...request, directory };
    },
    async result(agentId: string, operation: { id: string; launchId: string; generation: string; revision: number }) {
      const current = await read(agentId);
      const ledger = current?.ledger;
      if (!ledger || ledger.launchId !== operation.launchId || ledger.generation !== operation.generation)
        return { status: 'unknown' as const, detail: 'Claude observer changed or became unavailable' };
      if (ledger.revision !== operation.revision)
        return { status: 'unknown' as const, detail: 'User activity overlapped compaction; no automatic retry' };
      if (ledger.compact?.id !== operation.id || ledger.compact.status === 'running') return null;
      if (ledger.compact.revision !== operation.revision)
        return { status: 'unknown' as const, detail: 'Compaction receipt belongs to another activity revision' };
      return { status: ledger.compact.status, detail: ledger.compact.reason ??
        (ledger.compact.status === 'completed' ? 'Claude observed compaction completion' : 'Compaction did not complete') };
    },
    async cancel(operation: { directory: string; id: string }, sent = true) {
      const path = join(operation.directory, 'request.json');
      const request = JSON.parse(await readFile(path, 'utf8'));
      if (request.id !== operation.id) return;
      const ledger = LedgerSchema.safeParse(JSON.parse(await readFile(join(operation.directory, 'ledger.json'), 'utf8')));
      const consumed = ledger.success && ledger.data.compact?.id === operation.id;
      // Settled requests must not intercept later ordinary/manual compaction.
      // An unobserved send remains cancelled so a late PreCompact cannot run it.
      await atomic(path, { id: operation.id, status: !sent || consumed ? 'settled' : 'cancelled' });
    },
  };
}
