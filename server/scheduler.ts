import { randomUUID } from "node:crypto";
import { bounded } from "./deadline";
import type { Settings } from "../shared/settings";
import { operationPending, type CompactTarget, type Row } from "../shared/rpc";
import type { Gateway, Job, Observation, State, StateStore, StoredOperation } from "./model";

import { createOperationWorker, recoverOperations, OPERATION_TIMEOUT_MS, inputFingerprint, operationStatus, publicOperation, sameActivity } from "./operations";
import { HISTORY_RETENTION_MS, HISTORY_SWEEP_INTERVAL_MS, pruneOperationHistory, type OperationReceipts } from "./retention";

// This is a delivery grace period, never a claim about the provider cache TTL.
export const DELIVERY_WINDOW_MS = 5 * 60_000;
const terminal = (job: Job) =>
  ["expired", "skipped", "completed", "failed", "unknown"].includes(job.status);

export function createScheduler(options: {
  store: StateStore;
  gateway: Gateway;
  settings: () => Promise<Settings | null>;
  now?: () => number;
  onError?: (error: unknown) => void;
  receipts?: OperationReceipts;
}) {
  const { store, gateway } = options;
  const settings = () => bounded(options.settings(), 5_000);
  const refresh = (id: string) => bounded(gateway.refresh(id), 5_000);
  const now = options.now ?? Date.now;
  const onError = options.onError ?? (() => {});
  let tail: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let nextCleanupAt = -Infinity;
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  const due = (job: Job, config: Settings) =>
    job.endedAt + config.idleMinutes * 60_000;
  const allowed = (agent: Observation, config: Settings) =>
    agent.eligible && !config.disabledProviders.includes(agent.provider);
  function reversibleSkip(
    job: Job | undefined,
    agent: Observation,
    config: Settings | null
  ) {
    return !stopped && config && job?.status === "skipped" && job.skip &&
      job.attemptedAt === undefined && agent.eligible && agent.idle &&
      job.revision === agent.revision && job.skip.sessionId === agent.sessionId &&
      job.activityKey === agent.activityKey &&
      job.skip.dueAt === due(job, config) && job.skip.dueAt > now()
      ? job.skip : null;
  }
  async function recover() {
    const state = await store.read();
    const config = await settings().catch(() => null);
    recoverOperations(state, now());
    for (const job of state.jobs) {
      if (job.status === "running" && !state.operations.some(entry => entry.id === job.operationId)) {
        job.status = "unknown";
        job.detail = "Plugin restarted during compaction; no automatic retry";
      } else if (config && !terminal(job) && job.status !== "running" && now() >= due(job, config)) {
        job.status = "expired";
        job.detail =
          "Reservation elapsed while plugin was stopped; waiting for new conversation activity";
      }
    }
    await store.write(state);
    await cleanup();
  }
  async function cleanup() {
    if (stopped || !options.receipts) return;
    const at = now();
    if (at < nextCleanupAt && nextCleanupAt <= at + HISTORY_SWEEP_INTERVAL_MS) return;
    try {
      const state = await store.read();
      const result = await pruneOperationHistory(state, at, options.receipts, onError);
      if (result.changed) await store.write(state);
      // Only sweep orphans after the authoritative state commit succeeds.
      await options.receipts.sweep(state.operations, at - HISTORY_RETENTION_MS);
      nextCleanupAt = result.backlog ? -Infinity : at + HISTORY_SWEEP_INTERVAL_MS;
    } catch (error) { onError(error); }
  }
  const worker = createOperationWorker({ store, gateway, settings, now, onError,
    update: change => serialize(async () => {
      const state = await store.read();
      const result = change(state);
      await store.write(state);
      return result;
    }),
  });
  const ready = serialize(recover);

  async function view(
    agent: Observation,
    state: State,
    config: Settings | null
  ): Promise<Row> {
    const job = state.jobs.find((job) => job.agentId === agent.agentId);
    const operations = state.operations.filter(operation => operation.agentId === agent.agentId);
    const latestOperation = operations.at(-1) ?? null;
    const activeOperation = operations.find(operationPending) ?? null;
    const enabled = !state.disabled.includes(agent.agentId);
    let status: Row["status"] = "blocked";
    let detail = "Waiting for an observed ordinary turn to finish";
    if (
      job &&
      (job.revision === agent.revision ||
        terminal(job) ||
        job.status === "running")
    ) {
      status = job.status;
      detail = job.detail;
    }
    if (
      status === "scheduled" ||
      status === "blocked" ||
      status === "disabled" ||
      status === "busy"
    ) {
      if (!config) {
        status = "blocked";
        detail = "Settings unreadable";
      } else if (agent.tokens === null) {
        status = "blocked";
        detail = "Context usage unknown; no compaction will be sent";
      } else if (
        !config.enabled ||
        !enabled ||
        config.disabledProviders.includes(agent.provider)
      ) {
        status = "disabled";
        detail = "Automation off";
      } else if (!agent.idle) {
        status = "busy";
        detail = "Session running or waiting for permission";
      } else if (!gateway.automatic) {
        status = "blocked";
        detail = "A Claude observer is required for automatic compaction";
      } else if (gateway.readiness) {
        const blocked = await bounded(gateway.readiness(
          agent,
          job && config ? due(job, config) : undefined
        ), 5_000);
        if (blocked) {
          status = "blocked";
          detail = blocked;
        }
      }
    }
    if (!agent.idle && status !== "running") {
      status = "busy";
      detail = "Session running or waiting for permission";
    }
    if (activeOperation) {
      status = "running";
      detail = "Waiting for completed compaction boundary";
    }
    const skipped = activeOperation ? null : reversibleSkip(job, agent, config);
    if (status === 'scheduled' && agent.cache) {
      const { ttlMinutes, source } = agent.cache;
      detail += `; ${ttlMinutes}-minute cache ${source === 'default' ? 'assumed (TTL unavailable)' : `from ${source}`}`;
    }
    return {
      ...agent,
      enabled,
      target: { sessionId: agent.sessionId, activityKey: agent.activityKey ?? null },
      activeOperation: activeOperation ? publicOperation(activeOperation) : null,
      latestOperation: latestOperation ? publicOperation(latestOperation) : null,
      undoSkip: skipped ? { id: skipped.id, dueAt: skipped.dueAt } : null,
      dueAt:
        !activeOperation && job &&
        config &&
        job.revision === agent.revision &&
        !terminal(job) &&
        job.status !== "running"
          ? due(job, config)
          : null,
      status,
      detail,
      operationId: activeOperation?.id ?? job?.operationId ?? null,
    };
  }

  async function reserve(job: Job, state: State, operation: StoredOperation) {
    job.status = "running";
    job.detail = "Waiting for completed compaction boundary";
    job.attemptedAt = now();
    job.operationId = operation.id;
    state.operations.push(operation);
    await store.write(state);
  }
  function newOperation(job: Job, agent: Observation, kind: StoredOperation["kind"],
    id: string = randomUUID(), fingerprint: string | null = null): StoredOperation {
    return { id, agentId: job.agentId, revision: job.revision, kind,
      target: { sessionId: agent.sessionId, activityKey: agent.activityKey ?? null },
      inputFingerprint: fingerprint, state: "requested", createdAt: now(), updatedAt: now(), result: null,
      deadlineAt: now() + OPERATION_TIMEOUT_MS, reservationEndedAt: job.endedAt, attempt: 0 };
  }
  const existingResult = (operation: StoredOperation) => ({
    status: operationStatus(operation), detail: operation.result?.message ?? "Compaction requested",
    operationId: operation.id, operation: publicOperation(operation), code: "existing" as const,
  });

  return {
    ready,
    reconcile: worker.reconcile,
    stop() {
      stopped = true;
      worker.stop();
    },
    // Hooks are queued, but the gateway marks own turns synchronously before calling this.
    observedTurn: (agent: Observation, endedAt = now()) =>
      serialize(async () => {
        const state = await store.read();
        const prior = state.jobs.find((job) => job.agentId === agent.agentId);
        if (
          !agent.eligible ||
          !agent.idle ||
          !agent.revision ||
          Date.parse(agent.revision) > endedAt ||
          // Background notifications start native turns without a new host
          // message, so native activity identifies work when it is available.
          (agent.activityKey
            ? prior?.activityKey === agent.activityKey
            : prior?.revision === agent.revision) ||
          stopped
        )
          return;
        state.jobs = state.jobs.filter((job) => job.agentId !== agent.agentId);
        state.jobs.push({
          agentId: agent.agentId,
          revision: agent.revision,
          endedAt,
          ...(agent.activityKey ? { activityKey: agent.activityKey } : {}),
          ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
          status: "scheduled",
          detail:
            "Idle delay measured from observed Claude turn end",
        });
        await store.write(state);
      }),
    // Mark an old reservation unusable as soon as unrelated work starts or permission changes.
    invalidate: (agentId: string) =>
      serialize(async () => {
        const state = await store.read();
        const job = state.jobs.find((job) => job.agentId === agentId);
        if (job && ((job.status === "skipped" && job.skip) ||
            (!terminal(job) && job.status !== "running"))) {
          job.status = "skipped";
          job.detail = "Activity or session state changed";
          delete job.skip;
          await store.write(state);
        }
      }),
    // Conversation controls remain available below the automatic token threshold.
    session: (agentId: string) =>
      serialize(async () => {
        const [state, config, agent] = await Promise.all([
          store.read(),
          settings(),
          refresh(agentId),
        ]);
        return agent?.eligible ? view(agent, state, config) : null;
      }),
    list: () =>
      serialize(async () => {
        const [state, config, agents] = await Promise.all([
          store.read(),
          settings(),
          bounded(gateway.list(), 5_000),
        ]);
        return Promise.all(
          agents
            .filter(
              (agent) =>
                agent.eligible &&
                (agent.tokens === null ||
                  !config ||
                  agent.tokens >= config.threshold)
            )
            .map((agent) => view(agent, state, config))
        );
      }),
    toggle: (agentId: string, enabled: boolean) =>
      serialize(async () => {
        const state = await store.read();
        state.disabled = state.disabled.filter((id) => id !== agentId);
        if (!enabled) state.disabled.push(agentId);
        await store.write(state);
        return true;
      }),
    skip: (agentId: string, revision: string) =>
      serialize(async () => {
        if (stopped) return false;
        const [state, config, agent] = await Promise.all([
          store.read(), settings(), refresh(agentId),
        ]);
        const job = state.jobs.find(
          (job) => job.agentId === agentId && job.revision === revision
        );
        if (!job || terminal(job) || job.status === "running") return false;
        job.status = "skipped";
        job.detail = "This reservation skipped; session policy unchanged";
        if (config && agent?.eligible && agent.idle &&
            agent.revision === revision && agent.sessionId &&
            job.attemptedAt === undefined && due(job, config) > now()) {
          job.skip = { id: randomUUID(), dueAt: due(job, config), sessionId: agent.sessionId };
        } else delete job.skip;
        await store.write(state);
        return true;
      }),
    undoSkip: (agentId: string, revision: string, skipId: string) =>
      serialize(async () => {
        const [state, config, agent] = await Promise.all([
          store.read(), settings(), refresh(agentId),
        ]);
        const job = state.jobs.find(entry => entry.agentId === agentId);
        if (!agent || !job || job.revision !== revision ||
            job.skip?.id !== skipId || !reversibleSkip(job, agent, config)) return false;
        job.status = "scheduled";
        job.detail = "Skip undone; original reservation time preserved";
        delete job.skip;
        await store.write(state);
        return true;
      }),
    operation: (operationId: string) => serialize(async () => {
      const operation = (await store.read()).operations.find(entry => entry.id === operationId);
      return operation ? publicOperation(operation) : null;
    }),
    compactNow: async (agentId: string, revision: string, operationId: string = randomUUID(), target?: CompactTarget) => {
      const prepared = await serialize(async () => {
        const state = await store.read();
        const fingerprint = inputFingerprint(agentId, revision, target);
        const prior = state.operations.find(entry => entry.id === operationId);
        if (prior) return { result: prior.inputFingerprint === fingerprint
          ? existingResult(prior)
          : { status: "blocked" as const, detail: "Operation ID was already used with different input",
              operationId: null, operation: null, code: "idempotency_conflict" as const } };
        if (stopped || state.operations.some(operationPending))
          return {
            result: {
              status: "blocked" as const,
              detail: "Another compaction is running or plugin is stopping",
              operationId: null, operation: null, code: "blocked" as const,
            },
          };
        const [config, agent] = await Promise.all([
          settings(), refresh(agentId),
        ]);
        // An explicit request is independent of automation switches, like the threshold.
        const refused = !config
          ? "Compact settings could not be read"
          : !agent?.eligible
          ? "This conversation is unavailable for compaction"
          : agent.revision !== revision
          ? "The conversation changed. Refresh and try again"
          : target && (target.sessionId !== agent.sessionId || target.activityKey !== (agent.activityKey ?? null))
          ? "The conversation session or activity changed. Refresh and try again"
          : !agent.idle
          ? "The conversation is busy. Wait until it finishes"
          : null;
        if (refused || !agent)
          return { result: { status: "blocked" as const, detail: refused!, operationId: null,
            operation: null, code: "blocked" as const } };
        const attempted = state.operations.find(entry => sameActivity(entry, agent));
        if (attempted) return { result: existingResult(attempted) };
        let job = state.jobs.find((job) => job.agentId === agentId);
        if (
          job &&
          !state.operations.some(entry => entry.id === job?.operationId) &&
          sameActivity({ agentId: job.agentId, revision: job.revision,
            target: { sessionId: job.sessionId ?? null, activityKey: job.activityKey ?? null } }, agent) &&
          (job.attemptedAt !== undefined || job.status === "running")
        ) {
          return { result: { status: job.status, detail: job.detail,
            operationId: job.operationId ?? null, operation: null, code: "existing" as const } };
        }
        job = {
          agentId,
          revision,
          endedAt: now(),
          operationId,
          status: "scheduled",
          detail: "Explicit manual request",
          ...(agent.activityKey ? { activityKey: agent.activityKey } : {}),
          ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
        };
        state.jobs = [
          ...state.jobs.filter((entry) => entry.agentId !== agentId),
          job,
        ];
        const operation = newOperation(job, agent, "manual", operationId, fingerprint);
        await reserve(job, state, operation);
        return { job, agent, operation };
      });
      if ("result" in prepared) return prepared.result!;
      // Paseo plugin RPCs have a shorter deadline than a real Claude
      // compaction can take. Persist running before acknowledging the request,
      // then let the existing session polling observe the final outcome.
      void worker.reconcile().catch(onError);
      return {
        status: "running" as const,
        detail: "Compaction requested; waiting for completed compaction boundary",
        operationId: prepared.job.operationId!,
        operation: publicOperation(prepared.operation), code: "accepted" as const,
      };
    },
    tick: async (connected = true) => {
      await serialize(cleanup);
      await worker.reconcile(connected);
      const prepared = await serialize(async () => {
        if (stopped) return;
        const [state, config] = await Promise.all([store.read(), settings()]);
        if (!config || state.operations.some(operationPending)) return;
        let changed = false;
        for (const job of [...state.jobs].sort(
          (a, b) => a.endedAt - b.endedAt
        )) {
          if (terminal(job) || job.status === "running") continue;
          const at = now();
          if (at > due(job, config) + DELIVERY_WINDOW_MS) {
            job.status = "expired";
            job.detail = "Delivery window passed; no replay after sleep";
            changed = true;
            continue;
          }
          if (
            at < due(job, config) ||
            !config.enabled ||
            state.disabled.includes(job.agentId)
          )
            continue;
          if (!connected) continue;
          const agent = await refresh(job.agentId);
          if (
            !agent ||
            agent.revision !== job.revision ||
            (job.sessionId && agent.sessionId !== job.sessionId) ||
            (job.activityKey && agent.activityKey !== job.activityKey) ||
            !allowed(agent, config) ||
            agent.tokens === null ||
            agent.tokens < config.threshold ||
            !agent.idle
          ) {
            job.status = "skipped";
            job.detail = "Session changed or no longer eligible";
            changed = true;
            continue;
          }
          if (!gateway.automatic) {
            job.status = "blocked";
            job.detail =
              "Claude observer unavailable; nothing sent";
            changed = true;
            continue;
          }
          const blocked = gateway.readiness ? await bounded(gateway.readiness(agent, due(job, config)), 5_000) : null;
          if (blocked) {
            job.status = "blocked";
            job.detail = blocked;
            changed = true;
            continue;
          }
          // Settings can change while native observation/host refresh awaits I/O.
          const latest = await settings();
          if (
            stopped ||
            !latest ||
            !latest.enabled ||
            !allowed(agent, latest) ||
            agent.tokens < latest.threshold ||
            now() < due(job, latest)
          ) {
            job.status = "blocked";
            job.detail =
              "Automation policy or idle delay changed before dispatch";
            changed = true;
            continue;
          }
          if (now() > due(job, latest) + DELIVERY_WINDOW_MS) {
            job.status = "expired";
            job.detail = "Delivery window passed during inspection";
            changed = true;
            continue;
          }
          const attempted = state.operations.find(entry => sameActivity(entry, agent));
          if (attempted) {
            job.status = operationStatus(attempted);
            job.detail = attempted.result?.message ?? "Compaction already requested";
            job.operationId = attempted.id;
            job.attemptedAt = attempted.createdAt;
            changed = true;
            continue;
          }
          const operation = newOperation(job, agent, "automatic");
          operation.deliveryExpiresAt = due(job, latest) + DELIVERY_WINDOW_MS;
          operation.deadlineAt = Math.min(operation.deadlineAt!, operation.deliveryExpiresAt);
          await reserve(job, state, operation);
          // One operation per tick, host-wide serialization across all sessions.
          return { job, agent };
        }
        if (changed) await store.write(state);
      });
      if (prepared) await worker.reconcile(connected);
    },
  };
}
