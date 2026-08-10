import { describe, expect, test } from "bun:test";
import { approveComposioCall, MUTATING_SLUGS } from "../agent/tools/composio";

describe("composio mutation approvals", () => {
  test("mutating slugs are approved", () => {
    expect(approveComposioCall("GOOGLECALENDAR_CREATE_EVENT")).toBe(true);
    expect(approveComposioCall("GOOGLECALENDAR_DELETE_EVENT")).toBe(true);
    expect(approveComposioCall("GMAIL_SEND_EMAIL")).toBe(true);
    expect(approveComposioCall("TODOIST_CREATE_TASK")).toBe(true);
    expect(approveComposioCall("TODOIST_CLOSE_TASK")).toBe(true);
  });

  test("read slugs are not approved", () => {
    expect(approveComposioCall("GOOGLECALENDAR_EVENTS_LIST")).toBe(false);
    expect(approveComposioCall("GMAIL_FETCH_EMAILS")).toBe(false);
    expect(approveComposioCall("TODOIST_GET_ALL_TASKS")).toBe(false);
    expect(approveComposioCall("GOOGLECALENDAR_GET_CURRENT_DATE_TIME")).toBe(false);
  });

  test("unknown slugs are not approved", () => {
    expect(approveComposioCall("NOT_A_REAL_SLUG")).toBe(false);
    expect(approveComposioCall(undefined)).toBe(false);
  });

  test("MUTATING_SLUGS is a non-empty list with the exact allowlisted slugs", () => {
    expect(MUTATING_SLUGS.length).toBeGreaterThan(0);
    expect(MUTATING_SLUGS).toContain("GOOGLECALENDAR_CREATE_EVENT");
    expect(MUTATING_SLUGS).toContain("GMAIL_SEND_EMAIL");
    expect(MUTATING_SLUGS).toContain("TODOIST_CREATE_TASK");
  });
});
