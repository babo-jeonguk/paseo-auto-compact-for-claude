import type { PluginClientContext } from "@getpaseo/plugin/client";
import { installConversationControls } from "./client/conversations";
import { CompactSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  const stopSettings = client.addSettingsScreen({
    id: "automation",
    title: "Settings",
    icon: "Minimize2",
    Component: CompactSettingsScreen,
  });
  const stopConversations = installConversationControls(client);
  return async () => {
    await stopConversations();
    await stopSettings();
  };
}
