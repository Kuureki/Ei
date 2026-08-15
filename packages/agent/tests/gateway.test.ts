import { describe, expect, test } from "bun:test";
import { mapInteractionCreate, mapMessageCreate } from "../lib/gateway/gateway";
import { forwardInteraction, forwardMessage, runtimeIntakeUrl } from "../lib/gateway/index";

const OWNER = "123";
const BOT = "456";

describe("mapMessageCreate", () => {
  test("drops bots and non-owners", () => {
    expect(mapMessageCreate({ author: { id: OWNER, bot: true } }, OWNER, BOT)).toBeNull();
    expect(mapMessageCreate({ author: { id: "999" } }, OWNER, BOT)).toBeNull();
  });
  test("drops unmentioned owner messages in guild channels", () => {
    const m = mapMessageCreate(
      {
        id: "m1",
        author: { id: OWNER, bot: false },
        channel_id: "c1",
        channel: { type: 0 },
        guild_id: "g1",
        content: "hello",
        embeds: [{ url: "https://example.com" }, { url: undefined }],
        attachments: [],
      },
      OWNER,
      BOT,
    );
    expect(m).toBeNull();
  });
  test("keeps owner guild message that mentions the bot, requesting a thread", () => {
    const m = mapMessageCreate(
      {
        id: "m2",
        author: { id: OWNER, bot: false },
        channel_id: "c1",
        channel: { type: 0 },
        guild_id: "g1",
        content: "hey <@456>",
        mentions: [{ id: BOT }],
        attachments: [],
      },
      OWNER,
      BOT,
    );
    expect(m).not.toBeNull();
    expect(m!.threadRequested).toBe(true);
    expect(m!.messageId).toBe("m2");
  });
  test("detects mentions from raw text without the mentions array", () => {
    const m = mapMessageCreate(
      { id: "m3", author: { id: OWNER }, channel_id: "c1", channel: { type: 0 }, content: "hello <@!456>", attachments: [] },
      OWNER,
      BOT,
    );
    expect(m?.threadRequested).toBe(true);
  });
  test("keeps owner thread messages without any mention", () => {
    const m = mapMessageCreate(
      {
        id: "m4",
        author: { id: OWNER, bot: false },
        channel_id: "t1",
        channel: { type: 11 },
        thread: { id: "t1" },
        guild_id: "g1",
        content: "continue",
        embeds: [{ url: "https://example.com" }, { url: undefined }],
        attachments: [],
      },
      OWNER,
      BOT,
    );
    expect(m).not.toBeNull();
    expect(m!.threadId).toBe("t1");
    expect(m!.threadRequested).toBe(false);
    expect(m!.text).toBe("continue\n[link] https://example.com");
  });
  test("keeps owner thread messages when channel object is absent", () => {
    const m = mapMessageCreate(
      {
        id: "m4b",
        author: { id: OWNER, bot: false },
        channel_id: "t1",
        thread: { id: "t1" },
        guild_id: "g1",
        content: "follow up",
        attachments: [],
      },
      OWNER,
      BOT,
    );
    expect(m).not.toBeNull();
    expect(m!.threadId).toBe("t1");
    expect(m!.threadRequested).toBe(false);
  });
  test("keeps owner DMs without any mention", () => {
    const m = mapMessageCreate(
      { id: "m5", author: { id: OWNER }, channel_id: "dm1", channel: { type: 1 }, content: "dm", attachments: [] },
      OWNER,
      BOT,
    );
    expect(m?.threadRequested).toBe(false);
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
      { userId: OWNER, guildId: "g1", channelId: "c1", messageId: "m1", text: "hi", attachments: [] },
      { token: "bot-tok", secret: "sek", intakeUrl: "http://loop/intake", fetchImpl },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://loop/intake");
    expect(calls[0].body.text).toBe("hi");
  });

  test("forwardMessage creates a thread when mentioned and forwards into it", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      const u = String(url);
      const method = String((init as RequestInit)?.method ?? "GET");
      calls.push({ url: u, method, body: String((init as RequestInit)?.body ?? "") });
      if (u.endsWith("/threads") && method === "POST") {
        return new Response(JSON.stringify({ id: "t9" }), { status: 200 });
      }
      if (u.endsWith("/thread-members/@me")) return new Response("", { status: 204 });
      return new Response("ok");
    }) as typeof fetch;
    await forwardMessage(
      {
        userId: OWNER,
        guildId: "g1",
        channelId: "c1",
        messageId: "m1",
        threadRequested: true,
        text: "hey <@456> build me a thing",
        attachments: [],
      },
      { token: "bot-tok", secret: "sek", intakeUrl: "http://loop/intake", fetchImpl },
    );
    expect(calls[0]).toMatchObject({ url: "https://discord.com/api/v10/channels/c1/threads", method: "POST" });
    expect(JSON.parse(calls[0].body!)).toMatchObject({ type: 11, start_message_id: "m1" });
    expect(calls[1]).toMatchObject({ url: "https://discord.com/api/v10/channels/t9/thread-members/@me", method: "PUT" });
    expect(calls[2].url).toBe("http://loop/intake");
    expect(JSON.parse(calls[2].body!).threadId).toBe("t9");
  });

  test("forwardMessage degrades to the channel when thread creation fails", async () => {
    const calls: Array<string> = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;
    await forwardMessage(
      {
        userId: OWNER,
        guildId: "g1",
        channelId: "c1",
        messageId: "m1",
        threadRequested: true,
        text: "hey <@456>",
        attachments: [],
      },
      { token: "bot-tok", secret: "sek", intakeUrl: "http://loop/intake", fetchImpl },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("http://loop/intake");
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
