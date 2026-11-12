import { randomUUID } from "node:crypto";
import { bounded, INSPECT_TIMEOUT_MS, SEND_DEADLINE_MS } from "./deadline";
import type { Settings } from "../shared/settings";
import { operationPending, operationRowStatus, SESSION_RESUME_REQUIRED, type CompactTarget, type Row } from "../shared/rpc";
import { targetOf, unchanged, type Gateway, type Job, type Observation, type State, type StateStore,
  type StoredOperation } from "./model";
import { createOperationWorker, recoverOperations, inputFingerprint, mayHaveSent,
  publicOperation, sameActivity, syncJobs } from "./operations";
import { automaticBlock, dueAt, DELIVERY_WINDOW_MS } from "./policy";
import { HISTORY_RETENTION_MS, HISTORY_SWEEP_INTERVAL_MS, pruneOperationHistory, type OperationReceipts } from "./retention";

const jobTarget = (job: { sessionId?: string | null; activityKey?: string | null }): CompactTarget =>
  ({ sessionId: job.sessionId ?? null, activityKey: job.activityKey ?? null });
const UNAVAILABLE = "This conversation is unavailable for compaction";
const POLICY_CHANGED = "Automation policy or idle delay changed before dispatch";
const LATE_DURING_INSPECTION = "Delivery window passed during inspection";
const terminal = (job: Job) =>
  ["expired", "skipped", "completed", "failed", "unknown"].includes(job.status);
const pendingOf = (state: State, agentId: string) =>
  state.operations.find(entry => entry.agentId === agentId && operationPending(entry));

// The reservation a tick inspected, so phase C can tell whether it is still
// the same one after host I/O.
type Candidate = Pick<Job, "agentId" | "revision" | "endedAt"> & {
  activityKey: string | null; sessionId: string | null };
type ReservationOutcome = { kind: "expired" | "skipped" | "blocked"; detail: string } |
  { kind: "reserve"; agent: Observation; config: Settings };
type Decision = { candidate: Candidate; outcome: ReservationOutcome };

export function createScheduler(options: {
  store: StateStore;
  gateway: Gateway;
  settings: () => Promise<Settings | null>;
  now?: () => number;
  onError?: (error: unknown) => void;
  receipts?: OperationReceipts;
}) {
  const { gateway } = options;
  let stopped = false;
  // Every write passes through syncJobs, the only writer of jobs' attempt fields.
  // A stopped scheduler cannot write: it would put back state that a newer
  // instance has replaced since this one read it.
  const store: StateStore = { read: () => options.store.read(), write: async state => {
    if (stopped) throw new Error("Plugin stopped");
    await options.store.write(syncJobs(state));
  } };
  const settings = () => bounded(options.settings(), INSPECT_TIMEOUT_MS);
  const refresh = (id: string) => bounded(gateway.refresh(id), INSPECT_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  const onError = options.onError ?? (() => {});
  let tail: Promise<unknown> = Promise.resolve();
  let nextCleanupAt = -Infinity;
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  const due = (job: Job, config: Settings) => dueAt(job.endedAt, config);
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
      if (config && !terminal(job) && job.status !== "running" && now() >= due(job, config)) {
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
    // A transaction that changes nothing writes nothing.
    update: change => serialize(async () => {
      const state = await store.read(), before = JSON.stringify(state);
      const result = change(state);
      if (JSON.stringify(state) !== before) await store.write(state);
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
      } else if (agent.resumeRequired) {
        status = "blocked";
        detail = SESSION_RESUME_REQUIRED;
      } else if (gateway.readiness) {
        const blocked = await bounded(gateway.readiness(
          agent,
          job && config ? due(job, config) : undefined
        ), INSPECT_TIMEOUT_MS);
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
      target: targetOf(agent),
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
    job.operationId = operation.id;
    state.operations.push(operation);
    await store.write(state);
  }
  function newOperation(job: Job, agent: Observation, kind: "manual" | "automatic",
    id: string = randomUUID(), fingerprint: string | null = null): StoredOperation {
    return { id, agentId: job.agentId, revision: job.revision, kind,
      target: targetOf(agent),
      inputFingerprint: fingerprint, state: "requested", createdAt: now(), updatedAt: now(), result: null,
      sendBy: now() + SEND_DEADLINE_MS[kind], reservationEndedAt: job.endedAt, attempt: 0 };
  }
  // Automatic reservations are per conversation. Host reads and policy checks
  // run outside the state queue, and every decision is re-checked against fresh
  // state before it is written, so one slow or failing conversation cannot
  // delay another.
  let reservationPass: Promise<boolean> | null = null;
  function reserveDue(connected: boolean): Promise<boolean> {
    // A tick that arrives during inspection joins that pass instead of starting
    // a second one; cleanup and reconcile already tolerate overlapping calls.
    if (reservationPass) return reservationPass;
    const pass = reserveDueOnce(connected);
    reservationPass = pass;
    const reset = () => { if (reservationPass === pass) reservationPass = null; };
    pass.then(reset, reset);
    return pass;
  }
  async function reserveDueOnce(connected: boolean): Promise<boolean> {
    // Unreadable settings keep every reservation for the next tick.
    const config = await settings();
    if (!config || stopped) return false;
    // One policy call for every phase; `now` is read at the decision.
    const policy = (input: { agentId: string; endedAt: number; settings: Settings;
      disabled: readonly string[]; agent?: Observation }) => automaticBlock({ ...input, now: now() });
    // Phase A: read state under the queue and apply the timing policy.
    const { candidates, disabled } = await serialize(async () => {
      const state = await store.read();
      if (stopped) return { candidates: [] as Candidate[], disabled: state.disabled };
      let changed = false;
      const candidates: Candidate[] = [];
      for (const job of [...state.jobs].sort(
        (a, b) => a.endedAt - b.endedAt
      )) {
        if (terminal(job) || job.status === "running") continue;
        // Only this conversation's own pending operation holds its reservation.
        if (pendingOf(state, job.agentId)) continue;
        const timing = policy({ agentId: job.agentId, endedAt: job.endedAt,
          settings: config, disabled: state.disabled });
        if (timing === "late") {
          job.status = "expired";
          job.detail = "Delivery window passed; no replay after sleep";
          changed = true;
          continue;
        }
        if (timing || !connected) continue;
        candidates.push({ agentId: job.agentId, revision: job.revision, endedAt: job.endedAt,
          activityKey: job.activityKey ?? null, sessionId: job.sessionId ?? null });
      }
      if (changed) await store.write(state);
      return { candidates, disabled: state.disabled };
    });
    // Phase B: inspect the candidates concurrently and in isolation. A thrown
    // error leaves only that conversation's reservation untouched.
    const decisions = await Promise.all(candidates.map(async (candidate): Promise<Decision | null> => {
      try {
        const agent = await refresh(candidate.agentId);
        // An unreadable observer is not a changed session: keep the reservation.
        if (agent?.observerUnreadable) return null;
        if (
          !agent ||
          !unchanged({ revision: candidate.revision, target: jobTarget(candidate) }, agent) ||
          policy({ agentId: candidate.agentId, endedAt: candidate.endedAt,
            settings: config, disabled, agent }) === "ineligible"
        ) {
          return { candidate, outcome: { kind: "skipped",
            detail: "Session changed or no longer eligible" } };
        }
        if (!gateway.automatic) {
          return { candidate, outcome: { kind: "blocked",
            detail: "Claude observer unavailable; nothing sent" } };
        }
        if (agent.resumeRequired) {
          return { candidate, outcome: { kind: "blocked", detail: SESSION_RESUME_REQUIRED } };
        }
        const blocked = gateway.readiness
          ? await bounded(gateway.readiness(agent, dueAt(candidate.endedAt, config)), INSPECT_TIMEOUT_MS)
          : null;
        if (blocked) return { candidate, outcome: { kind: "blocked", detail: blocked } };
        // Settings can change while native observation/host refresh awaits I/O.
        // Unreadable settings are not a change either: keep the reservation.
        const latest = await settings();
        if (!latest) return null;
        const block = policy({ agentId: candidate.agentId, endedAt: candidate.endedAt,
          settings: latest, disabled, agent });
        if (block === "late") {
          return { candidate, outcome: { kind: "expired", detail: LATE_DURING_INSPECTION } };
        }
        if (block) {
          return { candidate, outcome: { kind: "blocked", detail: POLICY_CHANGED } };
        }
        return { candidate, outcome: { kind: "reserve", agent, config: latest } };
      } catch (error) {
        onError(error);
        return null;
      }
    }));
    // Phase C: apply every decision to fresh state, then write once.
    let reserved = false;
    await serialize(async () => {
      if (stopped) return;
      const state = await store.read();
      let changed = false;
      for (const decision of decisions) {
        if (!decision) continue;
        const { candidate, outcome } = decision;
        const job = state.jobs.find(entry => entry.agentId === candidate.agentId);
        if (!job || terminal(job) || job.status === "running") continue;
        if (job.revision !== candidate.revision || job.endedAt !== candidate.endedAt ||
            (job.activityKey ?? null) !== candidate.activityKey ||
            (job.sessionId ?? null) !== candidate.sessionId) continue;
        if (outcome.kind !== "reserve") {
          job.status = outcome.kind;
          job.detail = outcome.detail;
          changed = true;
          continue;
        }
        // A Compact now accepted meanwhile wins; it sends its own operation.
        if (pendingOf(state, job.agentId)) continue;
        // A toggle or a closed delivery window during inspection wins.
        const block = policy({ agentId: job.agentId, endedAt: job.endedAt,
          settings: outcome.config, disabled: state.disabled, agent: outcome.agent });
        if (block) {
          job.status = block === "late" ? "expired" : "blocked";
          job.detail = block === "late" ? LATE_DURING_INSPECTION : POLICY_CHANGED;
          changed = true;
          continue;
        }
        // Automatic work never repeats an activity, even one whose attempt sent nothing.
        const attempted = state.operations.find(entry => sameActivity(entry, outcome.agent));
        if (attempted) {
          job.operationId = attempted.id;
          changed = true;
          continue;
        }
        const operation = newOperation(job, outcome.agent, "automatic");
        // The delivery window limits when sending may start, not how long it is observed.
        operation.deliveryExpiresAt = dueAt(job.endedAt, outcome.config) + DELIVERY_WINDOW_MS;
        operation.sendBy = Math.min(operation.sendBy!, operation.deliveryExpiresAt);
        job.operationId = operation.id;
        state.operations.push(operation);
        changed = true;
        reserved = true;
      }
      if (changed) await store.write(state);
    });
    return reserved;
  }
  const existingResult = (operation: StoredOperation) => ({
    status: operationRowStatus(operation), detail: operation.result?.message ?? "Compaction requested",
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
    // Only the state read is queued: host reads and readiness checks run outside
    // the queue so one slow conversation cannot delay another's state changes.
    session: async (agentId: string) => {
      const [state, config, agent] = await Promise.all([
        serialize(() => store.read()),
        settings(),
        refresh(agentId),
      ]);
      return agent?.eligible ? view(agent, state, config) : null;
    },
    list: async () => {
      const [state, config, agents] = await Promise.all([
        serialize(() => store.read()),
        settings(),
        bounded(gateway.list(), INSPECT_TIMEOUT_MS),
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
    },
    toggle: (agentId: string, enabled: boolean) =>
      serialize(async () => {
        const state = await store.read();
        state.disabled = state.disabled.filter((id) => id !== agentId);
        if (!enabled) state.disabled.push(agentId);
        await store.write(state);
        return true;
      }),
    skip: async (agentId: string, revision: string) => {
      if (stopped) return false;
      const [config, agent] = await Promise.all([settings(), refresh(agentId)]);
      return serialize(async () => {
        if (stopped) return false;
        const state = await store.read();
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
      });
    },
    undoSkip: async (agentId: string, revision: string, skipId: string) => {
      const [config, agent] = await Promise.all([settings(), refresh(agentId)]);
      return serialize(async () => {
        const state = await store.read();
        const job = state.jobs.find(entry => entry.agentId === agentId);
        if (!agent || !job || job.revision !== revision ||
            job.skip?.id !== skipId || !reversibleSkip(job, agent, config)) return false;
        job.status = "scheduled";
        job.detail = "Skip undone; original reservation time preserved";
        delete job.skip;
        await store.write(state);
        return true;
      });
    },
    operation: (operationId: string) => serialize(async () => {
      const operation = (await store.read()).operations.find(entry => entry.id === operationId);
      return operation ? publicOperation(operation) : null;
    }),
    compactNow: async (agentId: string, revision: string, operationId: string = randomUUID(), target?: CompactTarget) => {
      const fingerprint = inputFingerprint(agentId, revision, target);
      // Answers that depend only on stored state. Both phases check them: a
      // request may be saved while this one runs its external reads.
      const storedAnswer = (state: State) => {
        const prior = state.operations.find(entry => entry.id === operationId);
        if (prior) return prior.inputFingerprint === fingerprint
          ? existingResult(prior)
          : { status: "blocked" as const, detail: "Operation ID was already used with different input",
              operationId: null, operation: null, code: "idempotency_conflict" as const };
        if (stopped) return { status: "blocked" as const, detail: "Plugin is stopping",
          operationId: null, operation: null, code: "blocked" as const };
        const pending = pendingOf(state, agentId);
        return pending ? existingResult(pending) : null;
      };
      const early = await serialize(async () => storedAnswer(await store.read()));
      if (early) return early;
      // Host and observer reads stay outside the state queue: one conversation's
      // slow inspection must not delay another conversation's state changes.
      const [config, agent] = await Promise.all([settings(), refresh(agentId)]);
      type CompactAnswer = NonNullable<ReturnType<typeof storedAnswer>> |
        { status: Job["status"]; detail: string; operationId: string | null;
          operation: null; code: "existing" };
      const prepared = await serialize(async (): Promise<
        { result: CompactAnswer } | { job: Job; agent: Observation; operation: StoredOperation }
      > => {
        // A request already in flight when this instance stopped must fail like
        // the store's own refusal; a newer instance may own the state now.
        if (stopped) throw new Error("Plugin stopped");
        const state = await store.read();
        const answered = storedAnswer(state);
        if (answered) return { result: answered };
        // First, which activity the request is about: without it nothing can be answered.
        const unidentified = !agent
          ? UNAVAILABLE
          : agent.observerUnreadable
          ? "Claude observer status unavailable. Try again"
          : agent.revision !== revision
          ? "The conversation changed. Refresh and try again"
          : target && !unchanged({ revision, target }, agent)
          ? "The conversation session or activity changed. Refresh and try again"
          : null;
        if (unidentified || !agent)
          return { result: { status: "blocked" as const, detail: unidentified!, operationId: null,
            operation: null, code: "blocked" as const } };
        // Then what already happened to that activity. History sends nothing, so
        // it is answered whatever the live state, such as a session that must
        // resume first. An explicit request repeats only work that sent nothing.
        const attempted = state.operations.find(entry => sameActivity(entry, agent) && mayHaveSent(entry));
        if (attempted) return { result: existingResult(attempted) };
        let job = state.jobs.find((job) => job.agentId === agentId);
        // After its history expires, the job's attemptedAt still guards the activity.
        if (
          job?.attemptedAt !== undefined &&
          !state.operations.some(entry => entry.id === job?.operationId) &&
          sameActivity({ agentId: job.agentId, revision: job.revision, target: jobTarget(job) }, agent)
        ) {
          return { result: { status: job.status, detail: job.detail,
            operationId: job.operationId ?? null, operation: null, code: "existing" as const } };
        }
        // Last, whether sending may start now. An explicit request is independent
        // of automation switches, like the threshold.
        const refused = !config
          ? "Compact settings could not be read"
          : !agent.eligible
          ? UNAVAILABLE
          : agent.resumeRequired
          ? SESSION_RESUME_REQUIRED
          : !agent.idle
          ? "The conversation is busy. Wait until it finishes"
          : null;
        if (refused)
          return { result: { status: "blocked" as const, detail: refused, operationId: null,
            operation: null, code: "blocked" as const } };
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
      if ("result" in prepared) return prepared.result;
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
    // A tick starts reconciliation, then inspects and reserves without waiting
    // for other work. It waits only for the runs it started, so `await tick()`
    // still means "sent". Automatic reservations are per conversation: another
    // conversation's pending operation is irrelevant, and every due reservation
    // of every conversation is handled in the same tick.
    tick: async (connected = true) => {
      await serialize(cleanup);
      const started = [worker.reconcile(connected)];
      if (await reserveDue(connected)) started.push(worker.reconcile(connected));
      await Promise.all(started);
    },
  };
}
