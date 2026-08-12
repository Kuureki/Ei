import { defineChannel, POST } from "eve/channels";
import { decodeToken, encodeToken, splitReply, type DiscordAddress } from "@ei/shared";
import { getExecutor } from "../../lib/db";
import { completeRun } from "../../lib/schedule-store";

interface InboundFile {
  name: string;
  mediaType: string;
  base64: string;
}

interface InboundBody {
  userId: string;
  guildId: string;
  channelId: string;
  threadId?: string;
  text: string;
  files?: InboundFile[];
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export default defineChannel({
  routes: [
    POST("/intake", async (request, { from }) => {
      if (request.headers.get("x-eve-connector-secret") !== process.env.EVE_CONNECTOR_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const body = (await request.json()) as InboundBody;
      if (body.userId !== process.env.AGENT_OWNER_DISCORD_ID) {
        // Single-owner gate: silently drop everyone else.
        return new Response("ignored", { status: 200 });
      }

      const address = encodeToken({
        guildId: body.guildId,
        channelId: body.channelId,
        threadId: body.threadId,
      });
      const content: Array<
        | { type: "text"; text: string }
        | { type: "file"; data: Uint8Array; mediaType: string; name?: string }
      > = [];
      if (body.text) content.push({ type: "text", text: body.text });
      for (const f of body.files ?? []) {
        const bytes = Buffer.from(f.base64, "base64");
        if (bytes.byteLength > MAX_FILE_BYTES) {
          await from(address).send(
            [{ type: "text", text: `Ignored "${f.name}": larger than 10 MB.` }],
            { auth: discordAuth(body) },
          );
          return new Response("ok", { status: 200 });
        }
        content.push({ type: "file", data: bytes, mediaType: f.mediaType, name: f.name });
      }
      if (content.length === 0) return new Response("empty", { status: 200 });

      await from(address).send(content, { auth: discordAuth(body) });
      return new Response("ok", { status: 200 });
    }),
  ],

  events: {
    "message.completed"(eventData, channel, ctx) {
      const addr = channel.continuation ? decodeToken(channel.continuation.token) : null;
      if (!addr) return;
      if (addr.scheduleRunId) {
        // A DB hiccup must not take message delivery down with it: only the
        // run-row write is skipped if getExecutor() or completeRun errors.
        try {
          void completeRun(getExecutor(), addr.scheduleRunId, {
            status: "succeeded",
            output: (eventData.message ?? "").slice(0, 4000),
            sessionId: ctx?.session?.id,
          }).catch(() => {});
        } catch {
          // no run row this turn; delivery continues
        }
      }
      const message: string | null = eventData.message;
      if (!message) return;
      void deliverToDiscord(addr, message);
    },
    "turn.failed"(eventData, channel, ctx) {
      const addr = channel.continuation ? decodeToken(channel.continuation.token) : null;
      if (!addr?.scheduleRunId) return;
      void completeRun(getExecutor(), addr.scheduleRunId, {
        status: "failed",
        error: typeof eventData.message === "string" ? eventData.message.slice(0, 1000) : "turn failed",
        sessionId: ctx?.session?.id,
      }).catch(() => {});
    },
    "turn.started"(_eventData, channel) {
      const addr = channel.continuation ? decodeToken(channel.continuation.token) : null;
      if (!addr) return;
      void startTyping(addr);
    },
  },

  receive(input, ctx) {
    const addr = encodeToken(input.target as unknown as DiscordAddress);
    return ctx.from(addr).send(input.message, { auth: input.auth });
  },
});

function discordAuth(body: InboundBody) {
  return {
    principalId: body.userId,
    principalType: "user" as const,
    authenticator: "discord",
    attributes: {
      guild_id: body.guildId,
      channel_id: body.channelId,
      thread_id: body.threadId ?? "",
      capture_kind: body.files?.length ? "file" : "text",
    },
  };
}

async function deliverToDiscord(
  addr: { channelId: string; threadId?: string },
  text: string,
): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;
  const channelId = addr.threadId ?? addr.channelId;
  for (const part of splitReply(text)) {
    await rateLimited(
      fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: part, allowed_mentions: { parse: [] } }),
      }),
    );
  }
}

async function startTyping(addr: { channelId: string; threadId?: string }): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://discord.com/api/v10/channels/${addr.threadId ?? addr.channelId}/typing`, {
    method: "POST",
    headers: { authorization: `Bot ${token}` },
  }).catch(() => {});
}

async function rateLimited(promise: Promise<Response>): Promise<Response> {
  let res = await promise;
  if (res.status === 429) {
    const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
    const wait = Math.min((data.retry_after ?? 1) * 1000, 30_000);
    await new Promise((r) => setTimeout(r, wait));
    res = await promise;
  }
  return res;
}
