import { describe, expect, test } from "bun:test";
import composioTools from "../agent/tools/composio";
import { getComposioSession } from "../agent/composio-session";

describe("composio tools surface", () => {
  test("module exposes a default export the agent can discover", () => {
    // eve discovers `agent/tools/composio.ts` by its default export. With no
    // COMPOSIO_API_KEY the dynamic resolver yields no tools (never throws).
    expect(composioTools).toBeDefined();
  });

  test("resolves to no tools when composio is not configured", async () => {
    delete process.env.COMPOSIO_API_KEY;
    expect(await getComposioSession({})).toBeNull();
  });
});
