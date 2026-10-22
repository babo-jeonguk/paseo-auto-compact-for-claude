import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator } from "react-native";
import { useEffect } from "react";
import { claudeProvider } from "../shared/providers";
import { ConversationControls, useConversation } from "./conversation";

type Agent = NonNullable<ReturnType<ReturnType<
  PluginClientContext["paseo"]["agents"]["ref"]
>["current"]>>;

// Only mounted composer icons poll session state. The directory refresh
// discovers conversations without polling the full scheduling list per session.
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

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind !== "upsert") {
      void refreshDirectory();
      return;
    }
    const { agent } = update;
    observed.set(agent.id, { agent, version: ++version });
    reconcile(agent);
  });

  async function refreshDirectory() {
    if (loading || stopped) return;
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
    } catch {
      // Visible badges report their own RPC errors. Retry directory discovery
      // after reconnect without destroying an already open conversation control.
    } finally {
      loading = false;
    }
  }
  void refreshDirectory();
  const timer = setInterval(() => void refreshDirectory(), 30_000);
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const { registration } of registrations.values()) registration.remove();
    registrations.clear();
    observed.clear();
  };
}
