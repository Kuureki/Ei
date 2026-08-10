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

// Mutating-slug allowlist for the approval gate. Slugs are the Composio tool
// slugs from the live Google Calendar / Gmail / Todoist toolkits; side-effecting
// actions pause on eve's approval flow, reads never prompt.
export const MUTATING_SLUGS = [
  // Google Calendar (events)
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT",
  "GOOGLECALENDAR_UPDATE_EVENT",
  "GOOGLECALENDAR_PATCH_EVENT",
  "GOOGLECALENDAR_IMPORT_EVENT",
  "GOOGLECALENDAR_MOVE_EVENT",
  "GOOGLECALENDAR_QUICK_ADD",
  // Gmail (send / modify / delete)
  "GMAIL_SEND_EMAIL",
  "GMAIL_SEND_DRAFT",
  "GMAIL_MOVE_TO_TRASH",
  "GMAIL_BATCH_DELETE_MESSAGES",
  "GMAIL_DELETE_THREAD",
  "GMAIL_MOVE_THREAD_TO_TRASH",
  "GMAIL_BATCH_MODIFY_MESSAGES",
  "GMAIL_MODIFY_THREAD_LABELS",
  // Todoist (tasks)
  "TODOIST_CREATE_TASK",
  "TODOIST_QUICK_ADD_TASK",
  "TODOIST_UPDATE_TASK",
  "TODOIST_DELETE_TASK",
  "TODOIST_CLOSE_TASK",
  "TODOIST_REOPEN_TASK",
  "TODOIST_MOVE_TASK",
  "TODOIST_BULK_CREATE_TASKS",
];

export function approveComposioCall(slugOrTool: unknown): boolean {
  const s = String(slugOrTool ?? "");
  return MUTATING_SLUGS.includes(s);
}
