// In-process Discord gateway: socket client + loopback forwarding.
// Pure global WebSocket/fetch — must stay runtime-agnostic (Node 24).
import { DiscordGateway, INTENTS, type InboundMessage, type InteractionEvent } from "./gateway";

export interface GatewayBootConfig {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function shouldStartGateway(env: NodeJS.ProcessEnv): boolean {
  const v = env.EVE_GATEWAY_DISABLED;
  return v !== "1" && v !== "true";
}

export function runtimeIntakeUrl(env: NodeJS.ProcessEnv): { intake: string; interact: string } {
  const port = Number(env.PORT ?? 3000);
  const base = env.EVE_RUNTIME_URL ?? `http://127.0.0.1:${port}`;
  return {
    intake: `${base}${env.EVE_INTAKE_PATH ?? "/intake"}`,
    interact: `${base}/interact`,
  };
}

export async function forwardMessage(
  msg: InboundMessage,
  deps: { token: string; secret: string; intakeUrl: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  if (msg.threadRequested && msg.messageId) {
    const threadId = await createThreadForMessage(f, deps.token, msg.channelId, msg.messageId, msg.text);
    if (threadId) msg.threadId = threadId;
  }
  const files: Array<{ name: string; mediaType: string; base64: string }> = [];
  for (const a of msg.attachments) {
    const res = await f(a.url, { headers: { authorization: `Bot ${deps.token}` } });
    if (!res.ok) {
      console.error("attachment download failed", a.name, res.status);
      continue;
    }
    files.push({
      name: a.name,
      mediaType: a.mediaType,
      base64: Buffer.from(await res.arrayBuffer()).toString("base64"),
    });
  }
  const res = await f(deps.intakeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eve-connector-secret": deps.secret },
    body: JSON.stringify({
      userId: msg.userId,
      guildId: msg.guildId,
      channelId: msg.channelId,
      threadId: msg.threadId,
      text: msg.text,
      files: files.length ? files : undefined,
    }),
  });
  const bodyText = await res.text().catch(() => "");
  if (!res.ok && bodyText !== "ignored") console.error("intake failed", res.status, bodyText);
  else console.log("intake ok");
}

// Mentioned in a guild channel: create a thread on the message so the
// conversation continues there without further mentions. Failures degrade
// gracefully to replying in the channel.
async function createThreadForMessage(
  f: typeof fetch,
  token: string,
  channelId: string,
  messageId: string,
  text: string,
): Promise<string | null> {
  const name = threadNameFrom(text);
  try {
    const res = await f(`https://discord.com/api/v10/channels/${channelId}/threads`, {
      method: "POST",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name,
        type: 11, // GUILD_PUBLIC_THREAD
        start_message_id: messageId,
        auto_archive_duration: 1440,
      }),
    });
    if (!res.ok) {
      console.error("thread create failed", res.status, await res.text().catch(() => ""));
      return null;
    }
    const thread = (await res.json()) as { id?: string };
    if (!thread.id) return null;
    await f(`https://discord.com/api/v10/channels/${thread.id}/thread-members/@me`, {
      method: "PUT",
      headers: { authorization: `Bot ${token}` },
    }).catch(() => {});
    console.log("thread created", thread.id);
    return thread.id;
  } catch (err) {
    console.error("thread create error", err);
    return null;
  }
}

function threadNameFrom(text: string): string {
  const cleaned = text
    .replace(/<@!?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 50) return cleaned || "conversation";
  return `${cleaned.slice(0, 49)}…`;
}

export async function forwardInteraction(
  ev: InteractionEvent,
  deps: { secret: string; interactUrl: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(deps.interactUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-eve-connector-secret": deps.secret },
      body: JSON.stringify({ interaction: ev }),
    });
    if (!res.ok) console.error("interact failed", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("interact error", err);
  }
}

export async function startGateway(boot: GatewayBootConfig = {}): Promise<void> {
  const env = boot.env ?? process.env;
  const f = boot.fetchImpl ?? fetch;
  const token = env.DISCORD_BOT_TOKEN ?? "";
  const ownerId = env.AGENT_OWNER_DISCORD_ID ?? "";
  const secret = env.EVE_CONNECTOR_SECRET ?? "";
  if (!token || !ownerId || !secret) {
    console.error("gateway disabled: DISCORD_BOT_TOKEN, AGENT_OWNER_DISCORD_ID, EVE_CONNECTOR_SECRET required");
    return;
  }
  const { intake, interact } = runtimeIntakeUrl(env);
  const gateway = new DiscordGateway({
    token,
    intents:
      INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT | INTENTS.DIRECT_MESSAGES,
    ownerId,
    gatewayUrl: env.EVE_GATEWAY_URL, // local testing only
    log: (line) => console.log(new Date().toISOString(), line),
    onMessage: (msg) => {
      void forwardMessage(msg, { token, secret, intakeUrl: intake, fetchImpl: f }).catch(() => {});
    },
    onInteraction: (ev) => {
      void forwardInteraction(ev, { secret, interactUrl: interact, fetchImpl: f }).catch(() => {});
    },
  });
  gateway.start();
  console.log("ei gateway started");
  const stop = () => {
    gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
