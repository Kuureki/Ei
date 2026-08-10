// Composio tools for eve: this file's default export is a `step.started`
// dynamic resolver that exposes the session's Tool Router meta-tools
// (COMPOSIO_SEARCH_TOOLS / COMPOSIO_MULTI_EXECUTE_TOOL /
// COMPOSIO_MANAGE_CONNECTIONS) plus the preloaded Calendar/Gmail/Todoist
// toolkits as eve-native defineTools.
import { defineComposioTools, type EveToolCollection } from "@composio/experimental/eve";
import { getComposioSession } from "../composio-session";

export default defineComposioTools(async () => {
  const session = await getComposioSession();
  if (!session) return { tools: async () => ({}) as EveToolCollection };
  return session;
});
