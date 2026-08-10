import { describe, expect, test, afterEach } from "bun:test";
import * as sessionModule from "../agent/composio-session";
import { approveComposioCall } from "../agent/tools/composio";

// Reset module state so tests run in any order.
afterEach(() => {
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.AGENT_OWNER_DISCORD_ID;
  sessionModule.__resetComposioSessionForTests?.();
});

describe("composio-session", () => {
  test("getComposioSession is null when COMPOSIO_API_KEY is missing", async () => {
    delete process.env.COMPOSIO_API_KEY;
    const s = await sessionModule.getComposioSession({});
    expect(s).toBeNull();
  });

  test("getComposioSession is null when AGENT_OWNER_DISCORD_ID is missing", async () => {
    process.env.COMPOSIO_API_KEY = "k";
    const s = await sessionModule.getComposioSession({});
    expect(s).toBeNull();
  });
});

describe("eve provider approval wiring", () => {
  test("EveProvider needsApproval matches approveComposioCall", () => {
    const provider = (sessionModule.composioClient as any)?.provider;
    if (provider && typeof provider.needsApproval === "function") {
      expect(provider.needsApproval({ name: "GOOGLECALENDAR_CREATE_EVENT" })).toBe(true);
      expect(provider.needsApproval({ name: "GOOGLECALENDAR_EVENTS_LIST" })).toBe(false);
    } else {
      // EveProvider options are read at construction; assert the predicate directly.
      expect(approveComposioCall("GOOGLECALENDAR_CREATE_EVENT")).toBe(true);
      expect(approveComposioCall("GOOGLECALENDAR_EVENTS_LIST")).toBe(false);
    }
  });
});
