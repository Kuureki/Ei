import { DiscordGateway, INTENTS } from "./gateway";

const token = process.env.DISCORD_BOT_TOKEN ?? "";
const ownerId = process.env.AGENT_OWNER_DISCORD_ID ?? "";
const secret = process.env.EVE_CONNECTOR_SECRET ?? "";
const runtimeUrl = process.env.EVE_RUNTIME_URL ?? "http://127.0.0.1:3000";
const intakePath = process.env.EVE_INTAKE_PATH ?? "/intake";
const gatewayUrl = process.env.EVE_GATEWAY_URL; // local testing only

if (!token || !ownerId || !secret) {
  console.error(
    "DISCORD_BOT_TOKEN, AGENT_OWNER_DISCORD_ID, and EVE_CONNECTOR_SECRET are required",
  );
  process.exit(1);
}

const gateway = new DiscordGateway({
  token,
  intents:
    INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT | INTENTS.DIRECT_MESSAGES,
  ownerId,
  gatewayUrl,
  log: (line) => console.log(new Date().toISOString(), line),
  onMessage: async (msg) => {
    try {
      const files: Array<{ name: string; mediaType: string; base64: string }> = [];
      for (const a of msg.attachments) {
        const res = await fetch(a.url, { headers: { authorization: `Bot ${token}` } });
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
      const res = await fetch(`${runtimeUrl}${intakePath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eve-connector-secret": secret },
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
      if (!res.ok && bodyText !== "ignored") {
        console.error("intake failed", res.status, bodyText);
      } else {
        console.log("intake ok");
      }
    } catch (err) {
      console.error("intake error", err);
    }
  },
});

gateway.start();
console.log("ei-connector started");

process.on("SIGINT", () => {
  gateway.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  gateway.stop();
  process.exit(0);
});
