// cli/env-sync.ts
// Prompts for the environment values `ei setup` needs and syncs them into
// Doppler (project ei / config prd). Runs after the project+config step so
// the build and command-registration steps actually have their secrets.
import type { EiConfig } from "./config";
import { run } from "./run";
import { dopplerSecrets } from "./env";
import { text, secretText } from "./ui/prompts";

export interface EnvVarDef {
  key: string;
  label: string;
  secret: boolean;
  default?: string;
}

export const SETUP_ENV_VARS: EnvVarDef[] = [
  { key: "WORKFLOW_POSTGRES_URL", label: "Postgres connection string (required; workflow world + agent tables)", secret: true },
  { key: "DISCORD_BOT_TOKEN", label: "Discord bot token", secret: true },
  { key: "DISCORD_APP_ID", label: "Discord application id", secret: false },
  { key: "AGENT_OWNER_DISCORD_ID", label: "Your Discord user id (owner gate)", secret: false },
  { key: "AGENT_OWNER_GUILD_ID", label: "Guild id for slash command registration", secret: false },
  { key: "EVE_CONNECTOR_SECRET", label: "Loopback connector secret (intake + interact routes)", secret: true },
  { key: "INNERNET_KEY", label: "innernet.live memory key", secret: true },
  { key: "PORT", label: "HTTP port", secret: false, default: "3000" },
  { key: "WORKFLOW_POSTGRES_JOB_PREFIX", label: "Scheduled-job queue prefix", secret: false, default: "ei" },
];

export interface EnvSyncDeps {
  existing: () => Promise<Record<string, string>>;
  setSecrets: (entries: Array<[string, string]>) => Promise<void>;
  ask: (def: EnvVarDef, hint: string) => Promise<string | null>;
}

export async function syncEnv(cfg: EiConfig, deps: EnvSyncDeps): Promise<{ set: string[]; skipped: string[] }> {
  const existing = await deps.existing();
  const entries: Array<[string, string]> = [];
  const skipped: string[] = [];
  for (const def of SETUP_ENV_VARS) {
    const current = existing[def.key];
    if (current && current.trim()) continue;
    const hint = process.env[def.key] ?? def.default ?? "";
    const value = await deps.ask(def, hint);
    if (value === null || !value.trim()) {
      skipped.push(def.key);
      continue;
    }
    entries.push([def.key, value.trim()]);
  }
  // Scope pins for the agent's own in-process doppler calls.
  entries.push(["DOPPLER_PROJECT", cfg.dopplerProject], ["DOPPLER_CONFIG", cfg.dopplerConfig]);
  if (entries.length) await deps.setSecrets(entries);
  return { set: entries.map(([k]) => k), skipped };
}

export function defaultEnvSyncDeps(cfg: EiConfig): EnvSyncDeps {
  return {
    existing: () => dopplerSecrets(cfg),
    setSecrets: async (entries) => {
      const args = ["doppler", "secrets", "set", "--project", cfg.dopplerProject, "--config", cfg.dopplerConfig];
      for (const [k, v] of entries) args.push(`${k}=${v}`);
      const r = await run(args);
      if (!r.ok) throw new Error(`doppler secrets set failed (${r.code})\n${r.stderr.slice(-1000)}`);
    },
    ask: (def, hint) => {
      const message = `${def.key} — ${def.label}`;
      return def.secret ? secretText(message, hint) : text(message, hint, def.default);
    },
  };
}