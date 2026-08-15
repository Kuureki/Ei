// cli/env-sync.test.ts
import { describe, expect, test } from "bun:test";
import { syncEnv } from "./env-sync";

const cfg = { checkoutPath: "/opt/ei", unitName: "ei", dopplerProject: "ei", dopplerConfig: "prd" };

describe("syncEnv", () => {
  test("prompts only for missing values, skips empties, pins doppler scope", async () => {
    const asked: string[] = [];
    const answers: Record<string, string> = {
      WORKFLOW_POSTGRES_URL: "postgres://db",
      DISCORD_BOT_TOKEN: "tok-1",
    };
    let saved: Array<[string, string]> = [];
    const { set, skipped } = await syncEnv(cfg, {
      existing: async () => ({ AGENT_OWNER_DISCORD_ID: "111" }),
      setSecrets: async (entries) => {
        saved = entries;
      },
      ask: async (def) => {
        asked.push(def.key);
        return answers[def.key] ?? null;
      },
    });
    expect(asked).toContain("WORKFLOW_POSTGRES_URL");
    expect(asked).toContain("DISCORD_BOT_TOKEN");
    expect(asked).not.toContain("AGENT_OWNER_DISCORD_ID");
    expect(saved).toContainEqual(["WORKFLOW_POSTGRES_URL", "postgres://db"]);
    expect(saved).toContainEqual(["DISCORD_BOT_TOKEN", "tok-1"]);
    expect(saved).toContainEqual(["DOPPLER_PROJECT", "ei"]);
    expect(saved).toContainEqual(["DOPPLER_CONFIG", "prd"]);
    expect(set).toContain("DOPPLER_PROJECT");
    expect(skipped).toEqual([
      "DISCORD_APP_ID",
      "AGENT_OWNER_GUILD_ID",
      "EVE_CONNECTOR_SECRET",
      "INNERNET_KEY",
      "PORT",
      "WORKFLOW_POSTGRES_JOB_PREFIX",
    ]);
  });

  test("skips already-set values entirely and reports skipped empties", async () => {
    const asked: string[] = [];
    const { set, skipped } = await syncEnv(cfg, {
      existing: async () => ({ WORKFLOW_POSTGRES_URL: "postgres://db", DISCORD_BOT_TOKEN: "tok", PORT: "3000" }),
      setSecrets: async () => {},
      ask: async (def) => {
        asked.push(def.key);
        return null;
      },
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain("WORKFLOW_POSTGRES_URL");
    expect(asked).not.toContain("DISCORD_BOT_TOKEN");
    expect(asked).not.toContain("PORT");
    expect(skipped).toContain("INNERNET_KEY");
    expect(set).toContain("DOPPLER_CONFIG");
  });
});