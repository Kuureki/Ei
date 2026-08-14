#!/usr/bin/env bun
// Register the provider slash commands. Run with Doppler env:
//   doppler run --project ei --config prd -- bun scripts/register-commands.ts [--dry-run|--list]
import { buildCommandDefinitions } from "../packages/agent/lib/registry";

const BASE = "https://discord.com/api/v10";

async function main(): Promise<number> {
  const dry = process.argv.includes("--dry-run");
  const list = process.argv.includes("--list");
  const token = process.env.DISCORD_BOT_TOKEN ?? "";
  const appId = process.env.DISCORD_APP_ID ?? "";
  const guildId = process.env.AGENT_OWNER_GUILD_ID ?? "";
  if (dry) {
    console.log(JSON.stringify(buildCommandDefinitions(), null, 2));
    console.log(`\nWould PUT ${BASE}/applications/${appId || "<app id>"}/guilds/${guildId || "<guild id>"}/commands`);
    return 0;
  }
  if (!token || !appId || !guildId) {
    console.error("DISCORD_BOT_TOKEN, DISCORD_APP_ID, AGENT_OWNER_GUILD_ID required (run under doppler run --).");
    return 2;
  }
  const url = `${BASE}/applications/${appId}/guilds/${guildId}/commands`;
  if (list) {
    const res = await fetch(url, { headers: { authorization: `Bot ${token}` } });
    console.log(JSON.stringify(await res.json(), null, 2));
    return 0;
  }
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(buildCommandDefinitions()),
  });
  if (!res.ok) {
    console.error("registration failed", res.status, await res.text());
    return 1;
  }
  console.log("commands registered:", JSON.stringify(await res.json(), null, 2));
  return 0;
}

process.exit(await main());
