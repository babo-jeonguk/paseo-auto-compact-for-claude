import { randomUUID } from "node:crypto";
import type { Settings } from "../shared/settings";
import type { Row } from "../shared/rpc";
import type { Gateway, Job, Observation, State, StateStore } from "./model";

// This is a delivery grace period, never a claim about the provider cache TTL.
export const DELIVERY_WINDOW_MS = 5 * 60_000;
const terminal = (job: Job) =>
  ["expired", "skipped", "completed", "failed", "unknown"].includes(job.status);

export function createScheduler(options: {
  store: StateStore;
  gateway: Gateway;
  settings: () => Promise<Settings | null>;
  now?: () => number;
}) {
  const { store, gateway, settings } = options;
  const now = options.now ?? Date.now;
  let tail: Promise<unknown> = Promise.resolve();
  let active = false;
  let stopped = false;
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
    const config = await settings();
    for (const job of state.jobs) {
      if (job.status === "running") {
        job.status = "unknown";
        job.detail = "Plugin restarted during compaction; no automatic retry";
      } else if (config && !terminal(job) && now() >= due(job, config)) {
        job.status = "expired";
        job.detail =
          "Reservation elapsed while plugin was stopped; waiting for new conversation activity";
      }
    }
    await store.write(state);
  }
  const ready = serialize(recover);

  async function view(
    agent: Observation,
    state: State,
    config: Settings | null
  ): Promise<Row> {
    const job = state.jobs.find((job) => job.agentId === agent.agentId);
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
        const blocked = await gateway.readiness(
          agent,
          job && config ? due(job, config) : undefined
        );
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
    const skipped = reversibleSkip(job, agent, config);
    if (status === 'scheduled' && agent.cache) {
      const { ttlMinutes, source } = agent.cache;
      detail += `; ${ttlMinutes}-minute cache ${source === 'default' ? 'assumed (TTL unavailable)' : `from ${source}`}`;
    }
    return {
      ...agent,
      enabled,
      undoSkip: skipped ? { id: skipped.id, dueAt: skipped.dueAt } : null,
      dueAt:
        job &&
        config &&
        job.revision === agent.revision &&
        !terminal(job) &&
        job.status !== "running"
          ? due(job, config)
          : null,
      status,
      detail,
    };
  }

  async function reserve(job: Job, state: State) {
    active = true;
    job.status = "running";
    job.detail = "Waiting for completed compaction boundary";
    job.attemptedAt = now();
    try {
      await store.write(state);
    } catch (error) {
      active = false;
      throw error;
    }
  }
  async function execute(job: Job, agent: Observation, automatic: boolean) {
    try {
      let result;
      try {
        if (stopped) throw new Error("Plugin stopping");
        const config = await settings();
        result = await (automatic
          ? gateway.automatic!(agent, {
              expiresAt: config ? due(job, config) + DELIVERY_WINDOW_MS : now(),
              allowed: async () => {
                const [latest, state] = await Promise.all([settings(), store.read()]);
                return !stopped && !!latest && latest.enabled && allowed(agent, latest) &&
                  agent.tokens !== null && agent.tokens >= latest.threshold &&
                  !state.disabled.includes(agent.agentId) && now() >= due(job, latest) &&
                  now() <= due(job, latest) + DELIVERY_WINDOW_MS;
              },
            })
          : gateway.compact(agent.agentId, agent));
      } catch {
        result = {
          status: "unknown" as const,
          detail: "Compaction result unknown; no automatic retry",
        };
      }
      const outcome = result;
      await serialize(async () => {
        const state = await store.read();
        const current = state.jobs.find(
          (entry) =>
            entry.agentId === job.agentId &&
            entry.revision === job.revision &&
            entry.attemptedAt === job.attemptedAt
        );
        if (current) {
          current.status = outcome.status;
          current.detail = outcome.detail;
          await store.write(state);
        }
      });
      return result;
    } finally {
      active = false;
    }
  }

  return {
    ready,
    stop() {
      stopped = true;
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
          prior?.revision === agent.revision ||
          (agent.activityKey && prior?.activityKey === agent.activityKey) ||
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
          gateway.refresh(agentId),
        ]);
        return agent?.eligible ? view(agent, state, config) : null;
      }),
    list: () =>
      serialize(async () => {
        const [state, config, agents] = await Promise.all([
          store.read(),
          settings(),
          gateway.list(),
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
          store.read(), settings(), gateway.refresh(agentId),
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
          store.read(), settings(), gateway.refresh(agentId),
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
    compactNow: async (agentId: string, revision: string) => {
      const prepared = await serialize(async () => {
        if (active || stopped)
          return {
            result: {
              status: "blocked" as const,
              detail: "Another compaction is running or plugin is stopping",
            },
          };
        const [state, config, agent] = await Promise.all([
          store.read(),
          settings(),
          gateway.refresh(agentId),
        ]);
        if (
          !config ||
          !agent ||
          !allowed(agent, config) ||
          !agent.idle ||
          agent.revision !== revision
        ) {
          return {
            result: {
              status: "blocked" as const,
              detail:
                "Session changed or is unavailable/busy",
            },
          };
        }
        let job = state.jobs.find((job) => job.agentId === agentId);
        if (
          job &&
          job.revision === revision &&
          (job.attemptedAt !== undefined || job.status === "running")
        ) {
          return { result: { status: job.status, detail: job.detail } };
        }
        job = {
          agentId,
          revision,
          endedAt: now(),
          status: "scheduled",
          detail: "Explicit manual request",
          ...(agent.activityKey ? { activityKey: agent.activityKey } : {}),
          ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
        };
        state.jobs = [
          ...state.jobs.filter((entry) => entry.agentId !== agentId),
          job,
        ];
        await reserve(job, state);
        return { job, agent };
      });
      return "result" in prepared
        ? prepared.result!
        : execute(prepared.job, prepared.agent, false);
    },
    tick: async (connected = true) => {
      const prepared = await serialize(async () => {
        if (stopped || active) return;
        const [state, config] = await Promise.all([store.read(), settings()]);
        if (!config) return;
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
          const agent = await gateway.refresh(job.agentId);
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
          const blocked = await gateway.readiness?.(agent, due(job, config));
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
          await reserve(job, state);
          // One operation per tick, host-wide serialization across all sessions.
          return { job, agent };
        }
        if (changed) await store.write(state);
      });
      if (prepared) await execute(prepared.job, prepared.agent, true);
    },
  };
}
