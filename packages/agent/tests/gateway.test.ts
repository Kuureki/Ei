import { describe, expect, test } from "bun:test";
import { mapInteractionCreate, mapMessageCreate } from "../lib/gateway/gateway";
import { forwardInteraction, forwardMessage, runtimeIntakeUrl } from "../lib/gateway/index";

const OWNER = "123";

describe("mapMessageCreate", () => {
  test("drops bots and non-owners", () => {
    expect(mapMessageCreate({ author: { id: OWNER, bot: true } }, OWNER)).toBeNull();
    expect(mapMessageCreate({ author: { id: "999" } }, OWNER)).toBeNull();
  });
  test("keeps owner messages and maps embeds to text", () => {
    const m = mapMessageCreate(
      {
        id: "m1",
        author: { id: OWNER, bot: false },
        channel_id: "c1",
        guild_id: "g1",
        content: "hello",
        embeds: [{ url: "https://example.com" }, { url: undefined }],
        attachments: [],
      },
      OWNER,
    );
    expect(m).not.toBeNull();
    expect(m!.text).toBe("hello\n[link] https://example.com");
    expect(m!.channelId).toBe("c1");
  });
});

describe("mapInteractionCreate", () => {
  test.each([2, 4, 5] as const)("keeps owner interaction type %i", (type) => {
    const ev = mapInteractionCreate(
      { id: "i1", type, token: "tok", channel_id: "c1", member: { user: { id: OWNER } }, data: { name: "x" } },
      OWNER,
    );
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe(type);
  });
  test("drops non-owner and unknown types", () => {
    expect(mapInteractionCreate({ id: "i2", type: 2, token: "t", member: { user: { id: "999" } } }, OWNER)).toBeNull();
    expect(mapInteractionCreate({ id: "i3", type: 0, token: "t", member: { user: { id: OWNER } } }, OWNER)).toBeNull();
  });
  test("reads user fallback, guild id, and modal custom_id", () => {
    const ev = mapInteractionCreate(
      { id: "i4", type: 5, token: "t", channel_id: "c1", guild_id: "g1", user: { id: OWNER }, data: { custom_id: "provider_add" } },
      OWNER,
    );
    expect(ev!.guildId).toBe("g1");
    expect(ev!.data.custom_id).toBe("provider_add");
  });
});

describe("forwarders", () => {
  test("runtimeIntakeUrl defaults to loopback", () => {
    expect(runtimeIntakeUrl({})).toEqual({
      intake: "http://127.0.0.1:3000/intake",
      interact: "http://127.0.0.1:3000/interact",
    });
    expect(runtimeIntakeUrl({ EVE_RUNTIME_URL: "http://host:9" })).toEqual({
      intake: "http://host:9/intake",
      interact: "http://host:9/interact",
    });
  });

  test("forwardMessage posts the normalized body with the secret header", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) });
      return new Response("ok");
    }) as typeof fetch;
    await forwardMessage(
      { userId: OWNER, guildId: "g1", channelId: "c1", text: "hi", attachments: [] },
      { token: "bot-tok", secret: "sek", intakeUrl: "http://loop/intake", fetchImpl },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://loop/intake");
    expect(calls[0].body.text).toBe("hi");
  });

  test("forwardInteraction posts { interaction } to /interact", async () => {
    const calls: Array<{ url: string; secret: string | null }> = [];
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      calls.push({
        url: String(url),
        secret: String(((init as RequestInit).headers as Record<string, string>)?.["x-eve-connector-secret"] ?? ""),
      });
      return new Response("ok");
    }) as typeof fetch;
    await forwardInteraction(
      { id: "i", type: 2, token: "t", userId: OWNER, channelId: "c1", data: {} },
      { secret: "sek", interactUrl: "http://loop/interact", fetchImpl },
    );
    expect(calls).toEqual([{ url: "http://loop/interact", secret: "sek" }]);
  });
});
