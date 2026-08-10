import { describe, expect, test, afterEach } from "bun:test";
import * as sessionModule from "../agent/composio-session";

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
