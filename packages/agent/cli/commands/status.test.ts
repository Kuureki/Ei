// cli/commands/status.test.ts
import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, type SqlExecutor } from "../../lib/db";
import { collectStatus } from "./status";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (t, p = []) => client.query(t, p as never[]) };
  await migrate(ex);
  return ex;
}

const cfg = { checkoutPath: "/opt/ei", unitName: "ei", dopplerProject: "ei", dopplerConfig: "prd" };

test("collectStatus degrades gracefully with no db and down health", async () => {
  const report = await collectStatus(cfg, {
    fetchImpl: () => Promise.reject(new Error("connect refused")),
    ex: null,
  });
  expect(report.health.ok).toBe(false);
  expect(report.degraded).toBe(true);
  expect(report.model).toBe("unknown");
});

test("collectStatus reads model and schedules from the db", async () => {
  const ex = await memExecutor();
  await ex.query(`insert into providers (id, name, base_url, key_env) values ('groq', 'Groq', 'https://api.groq.com/openai/v1', 'PROVIDER_GROQ_API_KEY')`);
  await ex.query(`insert into config (key, value, version) values ('active_model', $1::jsonb, 1)`, [JSON.stringify({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" })]);
  await ex.query(`insert into schedules (id, name, prompt, cadence, next_run_at, owner_discord_id, guild_id, dm_channel_id, enabled) values ('s1','digest','p','daily_at', now(), 'u1','g1','c1', true)`);
  const report = await collectStatus(cfg, {
    fetchImpl: () => Promise.resolve({ ok: true, status: 200 } as Response),
    ex,
  });
  expect(report.health.ok).toBe(true);
  expect(report.model).toContain("groq");
  expect(report.schedules).toBe(1);
});
