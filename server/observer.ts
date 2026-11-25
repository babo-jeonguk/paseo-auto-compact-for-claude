import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, lstat, rm } from 'node:fs/promises';
import { join, delimiter, sep } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { observerAsset } from './observer-assets.generated';
import { Refusal, type NativeOperation, type Observation, type StoredOperation } from './model';
import type { Blocked } from '../shared/rpc';
import { createCacheReader } from './cache';
import { CLOCK_STEP_TOLERANCE_MS } from './deadline';
import { createDurableWrites, type DurableWrites } from './durable';
import type { LeftoverDecision } from './model';

// Must equal QUERY_RESTARTED_REFUSAL in server/observer-source.mjs.
export const QUERY_RESTARTED_REFUSAL = 'query_restarted';
const QUERY_RESTARTED_DETAIL = 'Claude query restarted before compaction ran';

const PreparedIdentitySchema = z.object({
  launchId: z.string(), generation: z.string(), sessionId: z.string().nullable(),
  revision: z.number().int(),
});
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
    revision: z.number().int(), reason: z.string().nullable().optional(),
    refusal: z.string().nullable().optional(),
    // Which preparation of the native request the record belongs to; absent
    // from observers built by earlier releases.
    preparation: z.string().optional(),
    prepared: PreparedIdentitySchema.nullable().optional() }).nullable(),
});
type Ledger = z.infer<typeof LedgerSchema> & { cache: Awaited<ReturnType<ReturnType<typeof createCacheReader>>>;
  cacheDeadline: number | null };
const ReceiptSchema = z.object({
  id: z.string(), launchId: z.string(), generation: z.string(), sessionId: z.string().nullable(),
  revision: z.number().int(), status: z.enum(['completed', 'failed', 'unknown']),
  reason: z.string().nullable(), observedAt: z.number().finite(),
  refusal: z.string().nullable().optional(),
  preparation: z.string().optional(),
  prepared: PreparedIdentitySchema.nullable().optional(),
});
type NativeRecord = {
  id: string | null; launchId: string; generation: string; sessionId: string | null;
  revision: number; status: 'running' | 'completed' | 'failed' | 'unknown'; reason?: string | null;
  refusal?: string | null; preparation?: string;
  prepared?: z.infer<typeof PreparedIdentitySchema> | null;
};
// One rule for both durable receipts and live ledger polls: a record settles
// `operation` when it comes from the exact prepared observer identity and
// revision, or when a newer generation in the same launch and Claude session
// explicitly refused that exact prepared request because the query restarted.
// Completion always requires the exact prepared identity. A record that names
// another preparation of the operation settles nothing: that was a different
// request, however it ended.
function matchNativeRecord(record: NativeRecord, operation: NativeOperation) {
  if (record.id !== operation.id || record.status === 'running') return null;
  if (typeof record.preparation === 'string' && record.preparation !== operation.preparation) return null;
  if (record.launchId === operation.launchId && record.generation === operation.generation &&
      record.sessionId === operation.sessionId && record.revision === operation.revision) {
    return { status: record.status, detail: record.reason ??
      (record.status === 'completed' ? 'Claude observed compaction completion' : 'Compaction did not complete') };
  }
  if (record.status === 'failed' && record.refusal === QUERY_RESTARTED_REFUSAL &&
      record.launchId === operation.launchId && record.generation !== operation.generation &&
      operation.sessionId !== null && record.sessionId === operation.sessionId &&
      record.prepared?.launchId === operation.launchId &&
      record.prepared.generation === operation.generation &&
      record.prepared.sessionId === operation.sessionId &&
      record.prepared.revision === operation.revision) {
    return { status: 'failed' as const, detail: record.reason ?? QUERY_RESTARTED_DETAIL };
  }
  return null;
}
// `preparedAt` is absent from launches prepared by earlier releases.
const ManifestSchema = z.object({ launchId: z.string().uuid(), build: z.string(),
  preparedAt: z.number().finite().optional() });
// Ledgers and receipts are small; anything larger is not one of ours.
const MAX_FILE_BYTES = 32_768;
// The input-counting, command-guard, cancellation, clock-step and restart-refusal
// fixes keep the same ledger and reservation contract, as do comment-only edits.
// Keep already-open sessions observable until reopen.
const compatibleBuilds = new Set([observerAsset.version,
  'f8a02403e4f6c17e010ddda4d0385109fe8c480dfc379c9bb91d309671f87c7a',
  '61a0e12639e417cd28f7a651c789c00e10606bf994d960276f1916914eb3e6d4',
  'af6c6639f8c3058a73d5e982e308b69f5572fc6439a0c8fea61c1ca629ef4239',
  '8a6c0217779bc4f83c7029c8170c35da8d2ed8028622019f4a09808491dff90f',
  '7d9c570c36bcad4db9ef816c0b704c5b0d01d12c7522b215cdfbbfc160c86648',
  '9fa0456c8d59db1297e540db98993d8d23e34dbfb4a487843334926447ece70b',
  'ece7bf8ce5445aedb974f30472983b78c7358b8feea99d15c1ef2369d88a26e4',
  // v1.2.1
  '134e83d3751cca2f86c2ccda713162c7e739827df129e2020ab88a039c564e63',
  // main after #23 (query-restart refusal), installed by direct GitHub updates
  '35dc721b4f7cd02d1618f04fb9b9f856513ba21d07dc6abcac291911d94e8509',
  // v1.2.2
  '61b60834478e92325dc73fdb2b9235805997f990fe5ab8664bfef7ccc8f06d61']);

// What a placeholder ledger means. Session open writes `{}` and the observer
// replaces it on its first write, which it makes at session start and during
// any turn, `/compact` included. So once any turn (the host's last user message,
// which `/compact` also advances) has both started and finished after the
// launch was prepared, a placeholder means the observer never loaded. Until
// then it is starting.
// Waiting for the turn to finish, not just start, keeps this clear of the
// observer's first asynchronous write; no elapsed-time guess is involved.
export function placeholderReason(preparedAt: number, agent: Pick<Observation, 'idle' | 'revision'>): Blocked {
  const turnAt = agent.revision === null ? NaN : Date.parse(agent.revision);
  return agent.idle && turnAt > preparedAt
    ? { reason: 'observer_missing', detail: 'Claude observer did not load in this session; reopen it' }
    : { reason: 'observer_starting', detail: 'Claude observer starting; waiting for a completed reply' };
}

export function createObserver(options: { home?: string; now?: () => number; writes?: DurableWrites } = {}) {
  const base = join(options.home ?? process.env.PASEO_HOME ?? join(homedir(), '.paseo'),
    'plugin-data', 'auto-compact-for-claude', 'observers');
  const now = options.now ?? Date.now;
  const writes = options.writes ?? createDurableWrites();
  // The observer launch this plugin instance last started for each agent.
  const launchesStartedHere = new Map<string, string>();
  // Every preparation of a native request this instance made. Its own request
  // is its attempt's to retire, never a leftover from an earlier instance.
  const preparations = new Set<string>();
  // One writer of a file at a time in this instance, in call order. The next
  // waits for the previous one's actual file work to settle, not for a bounded
  // wait on it, so a delayed write lands where it was asked to; the entry goes
  // once that chain has ended.
  function serialize<K>(chains: Map<K, Promise<unknown>>) {
    return <T>(key: K, work: () => Promise<T>): Promise<T> => {
      const earlier = chains.get(key) ?? Promise.resolve();
      const result = earlier.then(work, work);
      const done = result.then(() => {}, () => {});
      chains.set(key, done);
      void done.then(() => { if (chains.get(key) === done) chains.delete(key); });
      return result;
    };
  }
  // One writer of a conversation's request.json, and one preparation of a
  // conversation's next launch (its current.json), at a time.
  const requestLock = serialize(new Map<string, Promise<unknown>>());
  const sessionLock = serialize(new Map<string, Promise<unknown>>());
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
  // The record a retired request leaves: the identity it retired and its
  // outcome. A preparation is named only when the request had one.
  const retiredRecord = (id: string, preparation: unknown, status: 'settled' | 'cancelled') =>
    ({ id, ...(typeof preparation === 'string' ? { preparation } : {}), status });
  // Settled requests must not intercept later ordinary/manual compaction. An
  // unobserved send remains cancelled so a late PreCompact cannot run it.
  async function retiredStatus(directory: string, id: string, sent: boolean) {
    // The ledger can be caught mid-write; then only a durable receipt can prove consumption.
    const ledger = await readFile(join(directory, 'ledger.json'), 'utf8')
      .then(text => LedgerSchema.safeParse(JSON.parse(text)))
      .catch(() => null);
    // A durable receipt also proves Claude already consumed this request, even
    // if later activity overwrote ledger.compact before release ran.
    const recorded = await readFile(join(directory, '..', 'receipts', receiptName(id)), 'utf8')
      .then(text => {
        const parsed = ReceiptSchema.safeParse(JSON.parse(text));
        return parsed.success && parsed.data.id === id;
      })
      .catch(() => false);
    const consumed = (ledger?.success && ledger.data.compact?.id === id) || recorded;
    return !sent || consumed ? 'settled' as const : 'cancelled' as const;
  }
  // null means there is no usable observer: none launched, an incompatible,
  // closed or unsafe launch, or a heartbeat older than a minute. Failing to read
  // one is different and is thrown, so nothing treats a busy or half-written
  // file as proof that the observer is gone. A ledger still holding the
  // session-open placeholder is neither: it returns `ledger: null` with the
  // time its launch was prepared (see placeholderReason).
  async function read(agentId: string): Promise<{ ledger: Ledger; directory: string } |
    { ledger: null; directory: string; preparedAt: number } | null> {
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
    // A missing file is absence; its contents are read and parsed separately so
    // a ledger holding JSON null stays a malformed ledger rather than absence.
    const text = await load(async () => readFile(path, 'utf8'));
    if (text === null) return null;
    const raw: unknown = await load(async () => JSON.parse(text));
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0)
      // Launches from earlier releases recorded no preparation time; the
      // placeholder is written then and never touched until the observer writes.
      return { ledger: null, directory, preparedAt: manifest.preparedAt ?? info.mtimeMs };
    const ledger = await load(async () => LedgerSchema.parse(raw));
    if (!ledger || ledger.launchId !== manifest.launchId || ledger.closed ||
        now() < ledger.updatedAt - CLOCK_STEP_TOLERANCE_MS || now() - ledger.updatedAt > 60_000) return null;
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
  function reason(ledger: Ledger | undefined, agent: Observation, dueAt = now()): Blocked | null {
    if (!ledger || ledger.sessionId !== agent.sessionId)
      return { reason: 'observer_missing', detail: 'Claude observer unavailable; start a new conversation session' };
    if (ledger.activeTurns.length || ledger.pendingInputs || ledger.compact?.status === 'running')
      return { reason: 'claude_working', detail: 'Claude is still working' };
    if (ledger.cacheDeadline === null) return { reason: 'waiting_for_reply', detail: 'Waiting for an ordinary reply' };
    if (now() >= ledger.cacheDeadline - 30_000) return { reason: 'cache_window_passed', detail: 'Cache window passed' };
    if (dueAt >= ledger.cacheDeadline - 30_000) return { reason: 'idle_delay_exceeds_cache',
      detail: `Idle delay exceeds the ${ledger.cache?.ttlMinutes}-minute cache window (${ledger.cache?.source})` };
    return null;
  }
  async function cancel(operation: { directory: string; id: string; preparation?: string }, sent = true) {
    const path = join(operation.directory, 'request.json');
    // The read, the check and the write are one writer of this file, so they
    // cannot be split by a newer preparation landing in between.
    await writes.run(() => requestLock(path, async () => {
      const request = JSON.parse(await readFile(path, 'utf8'));
      if (!request || typeof request !== 'object' || request.id !== operation.id) return;
      // Retire only the preparation this call is about; a retry's newer
      // preparation of the same operation is left alone.
      if (operation.preparation !== undefined && request.preparation !== operation.preparation) return;
      await writes.replace(path, JSON.stringify(retiredRecord(operation.id, request.preparation,
        await retiredStatus(operation.directory, operation.id, sent))));
    }));
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
    async prepareSession(request: PluginSessionOpenRequest, eligible: boolean): Promise<PluginSessionOpenRequest> {
      if (!eligible || request.purpose !== 'interactive') return request;
      const parent = agentDirectory(request.agentId);
      // One preparation of a conversation at a time, so its launches, and the
      // current.json publication of each, land in call order: a delayed earlier
      // publication cannot replace a newer active launch.
      return sessionLock(parent, () => writes.run(async () => {
        const launchId = randomUUID();
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
        // The preparation time is durable so a restarted plugin reads a
        // placeholder ledger the same way (see placeholderReason).
        await writes.replace(join(parent, 'current.json'), JSON.stringify({ launchId, build: observerAsset.version, preparedAt: now() }));
        launchesStartedHere.set(request.agentId, launchId);
        // Best effort: a failed prune only leaves stale launch directories on disk,
        // and the launch must proceed.
        await prune(parent, launchId).catch(() => {});
        const existing = request.env.CLAUDE_CODE_PLUGIN_DIRS?.split(delimiter)
          .filter(path => path && !path.startsWith(parent + sep));
        return { ...request, env: { ...request.env,
          CLAUDE_CODE_PLUGIN_DIRS: [...(existing ?? []), mod].join(delimiter) } };
      }));
    },
    // In memory, so it never fails: whether this instance started that launch.
    startedHere: (agentId: string, launchId: string) => launchesStartedHere.get(agentId) === launchId,
    async readiness(agent: Observation, dueAt?: number): Promise<Blocked | null> {
      // A status display; an unreadable observer is reported, never thrown.
      const current = await read(agent.agentId).catch(() => undefined);
      if (current === undefined)
        return { reason: 'observer_unreadable', detail: 'Claude observer status unavailable; retrying' };
      if (current?.ledger === null) return placeholderReason(current.preparedAt, agent);
      return reason(current?.ledger, agent, dueAt);
    },
    async prepare(agent: Observation, requireCache: boolean, expiresAt: number, id: string = randomUUID()) {
      const current = await read(agent.agentId);
      if (current?.ledger === null) {
        const placeholder = placeholderReason(current.preparedAt, agent);
        // A starting observer is a fault: retried until the send deadline.
        if (placeholder.reason === 'observer_starting') throw new Error(placeholder.detail);
        throw new Refusal(placeholder.detail);
      }
      if (!current || current.ledger.sessionId !== agent.sessionId) throw new Refusal('Claude observer unavailable');
      const { ledger, directory } = current;
      if (ledger.activeTurns.length || ledger.pendingInputs || ledger.compact?.status === 'running')
        throw new Refusal('Claude is still working');
      if (requireCache) { const blocked = reason(ledger, agent); if (blocked) throw new Refusal(blocked.detail); }
      const preparation: string = randomUUID();
      const request = { id, preparation, launchId: ledger.launchId, generation: ledger.generation,
        sessionId: ledger.sessionId, revision: ledger.revision, preparedAt: now(), expiresAt,
        requireCache, cacheDeadline: ledger.cacheDeadline, clockEpoch: ledger.clockEpoch, status: 'prepared' };
      // Remembered before the write, so a recovery scan running meanwhile can
      // tell this instance's preparation from a leftover even before it lands.
      preparations.add(preparation);
      const receipts = join(agentDirectory(agent.agentId), 'receipts');
      const path = join(directory, 'request.json');
      return writes.run(async () => {
        await mkdir(receipts, { recursive: true, mode: 0o700 });
        // Pre-create the file for the Mod filesystem capability. Never erase a receipt.
        await writeFile(receiptPath(agent.agentId, id), '{}', { mode: 0o600, flag: 'wx' })
          .catch(error => { if (error.code !== 'EEXIST') throw error; });
        // Serialized with this request's other writers, so a delayed retirement
        // cannot replace this newer preparation.
        await requestLock(path, () => writes.replace(path, JSON.stringify(request)));
        return { ...request, directory };
      });
    },
    async receipt(agentId: string, operation: NativeOperation) {
      try {
        const path = receiptPath(agentId, operation.id);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
        const receipt = ReceiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        const matched = matchNativeRecord(receipt, operation);
        return matched ? { ...matched, observedAt: receipt.observedAt } : null;
      } catch { return null; }
    },
    async result(agentId: string, operation: NativeOperation) {
      // Polled after sending: a read failure means "no answer yet", never an outcome.
      const current = await read(agentId).catch(() => null);
      const ledger = current?.ledger;
      if (!ledger) return null; // transient/partial ledger reads are not terminal evidence
      if (ledger.launchId !== operation.launchId)
        return { status: 'unknown' as const, detail: 'Claude observer changed or became unavailable' };
      // A new generation in the same launch may be restarting the Claude query
      // under this send. Wait for its matching restart refusal instead of
      // leaving live observation and cancelling request.json prematurely.
      if (ledger.generation !== operation.generation) {
        if (!ledger.compact || ledger.compact.status === 'running') return null;
        return matchNativeRecord({ ...ledger.compact, launchId: ledger.launchId,
          generation: ledger.generation, sessionId: ledger.sessionId }, operation);
      }
      if (ledger.compact?.id !== operation.id || ledger.compact.status === 'running') return null;
      if (ledger.compact.revision !== operation.revision)
        return { status: 'unknown' as const, detail: 'Compaction receipt belongs to another activity revision' };
      return matchNativeRecord({ ...ledger.compact, launchId: ledger.launchId,
        generation: ledger.generation, sessionId: ledger.sessionId }, operation);
    },
    cancel,
    // A finished operation whose call did not end normally, such as one
    // recovered after a restart, may leave its native request prepared. Retire
    // it so that it can no longer claim a later /compact. A request this
    // instance prepared belongs to its own attempt and is left alone.
    async recoverPrepared(decide: LeftoverDecision) {
      const failures: unknown[] = [];
      const parents = await readdir(base, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of parents) {
        if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const parent = join(base, entry.name);
        try {
          // Never traverse a linked agent directory.
          const info = await lstat(parent);
          if (!info.isDirectory() || info.isSymbolicLink()) continue;
          const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(parent, 'current.json'), 'utf8')));
          const directory = join(parent, manifest.launchId), path = join(directory, 'request.json');
          await writes.run(() => requestLock(path, async () => {
            let request: { id?: unknown; preparation?: unknown; status?: unknown } | null;
            try {
              request = JSON.parse(await readFile(path, 'utf8'));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
              throw error;
            }
            if (!request || typeof request !== 'object') return;
            if (request.status !== 'prepared' || typeof request.id !== 'string') return;
            if (typeof request.preparation === 'string' && preparations.has(request.preparation)) return;
            const decision = decide({ id: request.id,
              ...(typeof request.preparation === 'string' ? { preparation: request.preparation } : {}) });
            if (decision === null) return;
            await writes.replace(path, JSON.stringify(retiredRecord(request.id, request.preparation,
              await retiredStatus(directory, request.id, decision.sent))));
          }));
        } catch (error) {
          // A missing manifest or launch is a conversation with nothing prepared.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          failures.push(error);
        }
      }
      // One conversation's failure does not keep the others' requests
      // prepared; it is reported once the scan has ended.
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures);
    },
    async release(agentId: string, operation: Pick<NativeOperation, 'id' | 'launchId' | 'preparation'>, sent: boolean) {
      const directory = join(agentDirectory(agentId), operation.launchId);
      const request = JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'));
      if (request.id === operation.id && request.status === 'prepared')
        await cancel({ directory, id: operation.id, preparation: operation.preparation }, sent);
    },
  };
}
