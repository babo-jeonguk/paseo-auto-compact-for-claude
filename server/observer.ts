import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename, lstat, rm } from 'node:fs/promises';
import { join, delimiter, sep } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { observerAsset } from './observer-assets.generated';
import { Refusal, type NativeOperation, type Observation, type StoredOperation } from './model';
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
const ReceiptSchema = z.object({
  id: z.string(), launchId: z.string(), generation: z.string(), sessionId: z.string().nullable(),
  revision: z.number().int(), status: z.enum(['completed', 'failed', 'unknown']),
  reason: z.string().nullable(), observedAt: z.number().finite(),
});
const ManifestSchema = z.object({ launchId: z.string().uuid(), build: z.string() });
// Ledgers and receipts are small; anything larger is not one of ours.
const MAX_FILE_BYTES = 32_768;
// The input-counting, command-guard and cancellation fixes keep the same ledger
// and reservation contract. Keep already-open sessions observable until reopen.
const compatibleBuilds = new Set([observerAsset.version,
  'f8a02403e4f6c17e010ddda4d0385109fe8c480dfc379c9bb91d309671f87c7a',
  '61a0e12639e417cd28f7a651c789c00e10606bf994d960276f1916914eb3e6d4',
  'af6c6639f8c3058a73d5e982e308b69f5572fc6439a0c8fea61c1ca629ef4239',
  '8a6c0217779bc4f83c7029c8170c35da8d2ed8028622019f4a09808491dff90f',
  '7d9c570c36bcad4db9ef816c0b704c5b0d01d12c7522b215cdfbbfc160c86648',
  '9fa0456c8d59db1297e540db98993d8d23e34dbfb4a487843334926447ece70b']);

export function createObserver(options: { home?: string; now?: () => number } = {}) {
  const base = join(options.home ?? process.env.PASEO_HOME ?? join(homedir(), '.paseo'),
    'plugin-data', 'auto-compact-for-claude', 'observers');
  const now = options.now ?? Date.now;
  const currentLaunches = new Map<string, string>();
  const cacheWindow = createCacheReader();
  const agentDirectory = (id: string) => join(base, createHash('sha256').update(id).digest('hex'));
  const receiptName = (id: string) => encodeURIComponent(id) + '.json';
  const receiptPath = (agentId: string, id: string) => join(agentDirectory(agentId), 'receipts', receiptName(id));
  async function receiptDirectory(parent: string) {
    // Never traverse a linked agent/receipt directory during cleanup.
    for (const path of [base, parent, join(parent, 'receipts')]) {
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe observer receipt directory');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }
    return join(parent, 'receipts');
  }
  const atomic = async (path: string, value: unknown) => {
    const temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  };
  // null means there is no usable observer: none launched, an incompatible,
  // closed or unsafe launch, or a heartbeat older than a minute. Failing to read
  // one is different and is thrown, so nothing treats a busy or half-written
  // file as proof that the observer is gone.
  async function read(agentId: string): Promise<{ ledger: Ledger; directory: string } | null> {
    // Reading and parsing together: a missing file is absence, anything else a fault.
    const load = async <T>(work: () => Promise<T>) => {
      try { return await work(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error('Claude observer could not be read', { cause: error });
      }
    };
    const parent = agentDirectory(agentId);
    const manifest = await load(async () =>
      ManifestSchema.parse(JSON.parse(await readFile(join(parent, 'current.json'), 'utf8'))));
    if (!manifest || !compatibleBuilds.has(manifest.build)) return null;
    const directory = join(parent, manifest.launchId);
    const path = join(directory, 'ledger.json');
    const info = await load(() => lstat(path));
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
    const ledger = await load(async () => LedgerSchema.parse(JSON.parse(await readFile(path, 'utf8'))));
    if (!ledger || ledger.launchId !== manifest.launchId || ledger.closed ||
        now() < ledger.updatedAt || now() - ledger.updatedAt > 60_000) return null;
    const cache = await cacheWindow(ledger.cacheRequest, ledger.transcriptPath,
      ledger.sessionId ?? '', ledger.ordinaryEndedAt, now());
    return { ledger: { ...ledger, cache, cacheDeadline: cache?.deadline ?? null }, directory };
  }
  // Each open writes a new launch. A running observer refreshes its ledger every
  // few seconds, so a closed or day-old launch belongs to an ended process.
  async function prune(parent: string, keep: string) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === keep || entry.name === 'receipts') continue;
      const directory = join(parent, entry.name), path = join(directory, 'ledger.json');
      try {
        // A launch still being prepared may not have its ledger yet.
        const info = await lstat(path).catch(() => lstat(directory));
        const closed = info.isFile() && info.size <= MAX_FILE_BYTES &&
          JSON.parse(await readFile(path, 'utf8')).closed === true;
        if (!closed && now() - info.mtimeMs < 24 * 60 * 60_000) continue;
      } catch { continue; }
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
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
    async removeReceipt(agentId: string, operationId: string) {
      const directory = await receiptDirectory(agentDirectory(agentId));
      if (directory) await rm(join(directory, receiptName(operationId)), { force: true });
    },
    async sweepReceipts(retained: readonly StoredOperation[], cutoff: number) {
      // Retained records protect even empty/partial receipts and old pending
      // work. This also finds receipts orphaned before the native checkpoint,
      // or recreated by a late save from an already-open older observer.
      const protectedFiles = new Set(retained.map(operation => receiptPath(operation.agentId, operation.id)));
      const parents = await readdir(base, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      let removed = 0;
      for (const parent of parents) {
        if (!parent.isDirectory() || !/^[a-f0-9]{64}$/.test(parent.name)) continue;
        const directory = await receiptDirectory(join(base, parent.name));
        if (!directory) continue;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const path = join(directory, entry.name);
          if (protectedFiles.has(path)) continue;
          try {
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) continue;
            let timestamp = info.mtimeMs;
            try {
              const receipt = ReceiptSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
              if (receipt.success && receiptName(receipt.data.id) === entry.name)
                timestamp = receipt.data.observedAt;
            } catch { /* Old empty or partial orphan: use filesystem age. */ }
            if (timestamp > cutoff) continue;
            await rm(path, { force: true });
            if (++removed >= 100) return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
    },
    async prepareSession(request: PluginSessionOpenRequest, eligible: boolean) {
      if (!eligible || request.purpose !== 'interactive') return request;
      const parent = agentDirectory(request.agentId), launchId = randomUUID();
      const directory = join(parent, launchId), mod = join(directory, 'mod');
      await mkdir(join(mod, '.claude-plugin'), { recursive: true, mode: 0o700 });
      await mkdir(join(mod, 'hooks'), { recursive: true, mode: 0o700 });
      const receipts = join(parent, 'receipts');
      await mkdir(receipts, { recursive: true, mode: 0o700 });
      const configuration = { launchId, ledger: join(directory, 'ledger.json'), request: join(directory, 'request.json'), receipts };
      await writeFile(configuration.ledger, '{}', { mode: 0o600, flag: 'wx' });
      await writeFile(configuration.request, '{}', { mode: 0o600, flag: 'wx' });
      await writeFile(join(mod, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'paseo-auto-compact-observer', version: '1.0.0',
        description: 'Observe conversation activity and compaction for Paseo Auto Compact' }), { mode: 0o600 });
      await writeFile(join(mod, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.mjs'] }), { mode: 0o600 });
      await writeFile(join(mod, 'hooks', 'register.mjs'), observerAsset.source + '\nexport function register(on) { registerObserver(on, ' +
        JSON.stringify(configuration) + '); }\n', { mode: 0o600 });
      await atomic(join(parent, 'current.json'), { launchId, build: observerAsset.version });
      currentLaunches.set(request.agentId, launchId);
      await prune(parent, launchId).catch(() => {});
      const existing = request.env.CLAUDE_CODE_PLUGIN_DIRS?.split(delimiter)
        .filter(path => path && !path.startsWith(parent + sep));
      return { ...request, env: { ...request.env,
        CLAUDE_CODE_PLUGIN_DIRS: [...(existing ?? []), mod].join(delimiter) } };
    },
    async ownsCurrentLaunch(agentId: string) {
      const current = await read(agentId);
      return current ? currentLaunches.get(agentId) === current.ledger.launchId : null;
    },
    async readiness(agent: Observation, dueAt?: number) {
      // A status display; an unreadable observer is reported, never thrown.
      const current = await read(agent.agentId).catch(() => undefined);
      return current === undefined ? 'Claude observer status unavailable; retrying'
        : reason(current?.ledger, agent, dueAt);
    },
    async prepare(agent: Observation, requireCache: boolean, expiresAt: number, id: string = randomUUID()) {
      const current = await read(agent.agentId);
      if (!current || current.ledger.sessionId !== agent.sessionId) throw new Refusal('Claude observer unavailable');
      const { ledger, directory } = current;
      if (ledger.activeTurns.length || ledger.pendingInputs || ledger.compact?.status === 'running')
        throw new Refusal('Claude is still working');
      if (requireCache) { const blocked = reason(ledger, agent); if (blocked) throw new Refusal(blocked); }
      const request = { id, launchId: ledger.launchId, generation: ledger.generation,
        sessionId: ledger.sessionId, revision: ledger.revision, preparedAt: now(), expiresAt,
        requireCache, cacheDeadline: ledger.cacheDeadline, clockEpoch: ledger.clockEpoch, status: 'prepared' };
      const receipts = join(agentDirectory(agent.agentId), 'receipts');
      await mkdir(receipts, { recursive: true, mode: 0o700 });
      // Pre-create the file for the Mod filesystem capability. Never erase a receipt.
      await writeFile(receiptPath(agent.agentId, id), '{}', { mode: 0o600, flag: 'wx' })
        .catch(error => { if (error.code !== 'EEXIST') throw error; });
      await atomic(join(directory, 'request.json'), request);
      return { ...request, directory };
    },
    async receipt(agentId: string, operation: NativeOperation) {
      try {
        const path = receiptPath(agentId, operation.id);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
        const receipt = ReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        if (receipt.id !== operation.id || receipt.launchId !== operation.launchId ||
            receipt.generation !== operation.generation || receipt.sessionId !== operation.sessionId ||
            receipt.revision !== operation.revision) return null;
        return { status: receipt.status, observedAt: receipt.observedAt, detail: receipt.reason ??
          (receipt.status === 'completed' ? 'Claude observed compaction completion' : 'Compaction did not complete') };
      } catch { return null; }
    },
    async result(agentId: string, operation: Omit<NativeOperation, 'sessionId'>) {
      // Polled after sending: a read failure means "no answer yet", never an outcome.
      const current = await read(agentId).catch(() => null);
      const ledger = current?.ledger;
      if (!ledger) return null; // transient/partial ledger reads are not terminal evidence
      if (ledger.launchId !== operation.launchId || ledger.generation !== operation.generation)
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
