// cli/env.ts
import type { SqlExecutor } from "../lib/db";
import { createPool, poolExecutor } from "../lib/db";
import type { EiConfig } from "./config";
import { run } from "./run";

export async function dopplerSecrets(cfg: EiConfig): Promise<Record<string, string>> {
  const r = await run(["doppler", "secrets", "download", "--project", cfg.dopplerProject, "--config", cfg.dopplerConfig, "--no-file", "--format", "json"]);
  if (!r.ok) throw new Error(`doppler secrets download failed (exit ${r.code})`);
  try {
    return JSON.parse(r.stdout) as Record<string, string>;
  } catch {
    throw new Error("doppler secrets returned invalid JSON");
  }
}

export async function safeSecrets(cfg: EiConfig): Promise<Record<string, string>> {
  try {
    return await dopplerSecrets(cfg);
  } catch {
    return {};
  }
}

export async function openDb(cfg: EiConfig): Promise<SqlExecutor | null> {
  try {
    const secrets = await dopplerSecrets(cfg);
    const url = secrets.WORKFLOW_POSTGRES_URL;
    if (!url) return null;
    return poolExecutor(createPool(url));
  } catch {
    return null;
  }
}

export function mergedEnv(secrets: Record<string, string>): Record<string, string | undefined> {
  return { ...secrets, ...process.env } as Record<string, string | undefined>;
}
