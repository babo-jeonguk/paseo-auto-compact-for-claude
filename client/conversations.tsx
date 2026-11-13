import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator, AppState } from "react-native";
import { useEffect } from "react";
import { claudeProvider } from "../shared/providers";
import { directoryRefreshDelay, hostReconnected, onSessionRecovered, surfaceActive,
  type DirectoryTrigger } from "./cadence";
import { ConversationControls, useConversation } from "./conversation";
import { onSurfaceChange } from "./surface";

type Agent = NonNullable<ReturnType<ReturnType<
  PluginClientContext["paseo"]["agents"]["ref"]
>["current"]>>;

// Only mounted composer icons poll session state. Directory discovery refreshes
// on mount, reconnect (a failed directory refresh or a recovered status poll),
// visibility and directory events, with a 5-minute safety refresh.
export function installConversationControls(client: PluginClientContext) {
  const registrations = new Map<
    string,
    { workspaceId: string; registration: PluginButtonRegistration }
  >();
  const observed = new Map<string, { agent: Agent; version: number }>();
  let providers: Record<string, unknown> | null = null;
  let version = 0;
  let stopped = false;
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = surfaceActive(AppState.currentState);
  let failed = false; // last refresh failed: the next host event means the host is reachable again
  let announced = false; // this outage already refreshed mounted status controls
  let again = false; // a trigger arrived while a refresh was running

  function reconcile(agent: Agent) {
    if (stopped || !providers) return;
    const eligible =
      claudeProvider(providers, agent.provider) &&
      !!agent.workspaceId &&
      !agent.archivedAt &&
      !agent.internal &&
      !agent.providerUnavailable &&
      !agent.labels["paseo.parent-agent-id"] &&
      agent.status !== "closed";
    const old = registrations.get(agent.id);
    if (!eligible || (old && old.workspaceId !== agent.workspaceId)) {
      old?.registration.remove();
      registrations.delete(agent.id);
    }
    if (!eligible || registrations.has(agent.id)) return;

    let registration: PluginButtonRegistration | undefined;
    function StatusIcon(props: PluginButtonIconProps) {
      const state = useConversation(props.host.id, agent.id);
      useEffect(() => {
        registration?.update({
          label: state.status ?? undefined,
        });
      }, [state.status]);
      return state.loading ? <ActivityIndicator size="small" color={props.color} />
        : <Icon name="Minimize2" size={props.size} color={props.color} />;
    }
    registration = client.addComposerPill({
      id: `conversation-${agent.id}`,
      workspaceId: agent.workspaceId!,
      agentId: agent.id,
      button: {
        title: "Auto Compact",
        icon: StatusIcon,
        behavior: {
          kind: "popover",
          Content: (props) => (
            <ConversationControls
              {...props}
              agentId={agent.id}
              onSettings={() => {
                props.close();
                client.openSettings("automation");
              }}
            />
          ),
        },
      },
    });
    registrations.set(agent.id, {
      workspaceId: agent.workspaceId!,
      registration,
    });
  }

  function schedule(trigger: DirectoryTrigger) {
    if (stopped) return;
    clearTimeout(timer);
    timer = undefined;
    const delay = directoryRefreshDelay({ trigger, active });
    if (delay === false) return;
    if (delay === 0) void refreshDirectory();
    else timer = setTimeout(() => void refreshDirectory(), delay);
  }

  // Upserts arrive repeatedly during a turn, so broadcast once per outage.
  function reconnected(force = false) {
    schedule("reconnect");
    if (announced && !force) return;
    announced = true;
    hostReconnected();
  }

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind !== "upsert") {
      schedule("agents-changed");
      return;
    }
    const { agent } = update;
    observed.set(agent.id, { agent, version: ++version });
    reconcile(agent);
    if (failed) reconnected();
  });

  async function refreshDirectory() {
    if (loading) {
      again = true;
      return;
    }
    if (stopped) return;
    loading = true;
    const started = version;
    try {
      const { config } = await client.paseo.config.get();
      if (stopped) return;
      providers = config.providers;
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.paseo.agents.list({
          filter: { includeBackground: true },
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        if (stopped) return;
        for (const { agent } of page.entries) {
          seen.add(agent.id);
          if ((observed.get(agent.id)?.version ?? -1) <= started)
            observed.set(agent.id, { agent, version: started });
        }
        cursor = page.pageInfo.hasMore
          ? page.pageInfo.nextCursor ?? undefined
          : undefined;
      } while (cursor);
      for (const [id, entry] of observed) {
        if (!seen.has(id) && entry.version <= started) {
          registrations.get(id)?.registration.remove();
          registrations.delete(id);
          observed.delete(id);
        } else reconcile(entry.agent);
      }
      failed = false;
    } catch {
      // Visible badges report their own RPC errors. Retry directory discovery
      // after reconnect without destroying an already open conversation control.
      failed = true;
      announced = false;
    } finally {
      loading = false;
      if (again) {
        again = false;
        schedule("agents-changed");
      } else schedule("interval");
    }
  }
  schedule("mount");
  const stopRecovered = onSessionRecovered(() => reconnected(true));
  const stopSurface = onSurfaceChange(next => {
    const was = active;
    active = next;
    if (next && !was) schedule("visible");
    else if (!next) {
      clearTimeout(timer);
      timer = undefined;
    }
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    stopRecovered();
    stopSurface();
    unsubscribe();
    for (const { registration } of registrations.values()) registration.remove();
    registrations.clear();
    observed.clear();
  };
}
