// cli/commands/provider.test.ts
import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, jsonValue, type SqlExecutor } from "../../lib/db";
import { providerList, providerUse } from "./provider";

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

test("providerList reports providers, counts, and active model", async () => {
  const ex = await memExecutor();
  await ex.query(`insert into providers (id, name, base_url, key_env) values ('groq', 'Groq', 'https://api.groq.com/openai/v1', 'PROVIDER_GROQ_API_KEY')`);
  await ex.query(`insert into models_cache (provider_id, model_id, source) values ('groq', 'llama-3.3-70b-versatile', 'endpoint')`);
  await ex.query(`insert into config (key, value, version) values ('active_model', $1::jsonb, 1)`, [JSON.stringify({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" })]);
  const rows = await providerList(ex, { PROVIDER_GROQ_API_KEY: "sk-test" });
  expect(rows.providers).toHaveLength(1);
  expect(rows.providers[0]).toMatchObject({ name: "Groq", keySet: true, models: 1, active: true });
});

test("providerUse sets the active model", async () => {
  const ex = await memExecutor();
  await ex.query(`insert into providers (id, name, base_url, key_env) values ('groq', 'Groq', 'https://api.groq.com/openai/v1', 'PROVIDER_GROQ_API_KEY')`);
  await ex.query(`insert into models_cache (provider_id, model_id, source) values ('groq', 'm1', 'endpoint')`);
  await providerUse(ex, "m1");
  const r = await ex.query(`select value from config where key = 'active_model'`);
  expect((jsonValue(r.rows[0].value) as { model_id: string }).model_id).toBe("m1");
  expect((jsonValue(r.rows[0].value) as { reasoning_level: unknown }).reasoning_level).toBeNull();
});

test("providerUse persists and validates --reasoning", async () => {
  const ex = await memExecutor();
  await ex.query(`insert into providers (id, name, base_url, key_env) values ('groq', 'Groq', 'https://api.groq.com/openai/v1', 'PROVIDER_GROQ_API_KEY')`);
  await ex.query(`insert into models_cache (provider_id, model_id, source) values ('groq', 'm1', 'endpoint')`);
  await providerUse(ex, "m1", "high");
  const r = await ex.query(`select value from config where key = 'active_model'`);
  expect((jsonValue(r.rows[0].value) as { reasoning_level: string }).reasoning_level).toBe("high");
  await expect(providerUse(ex, "m1", "turbo")).rejects.toThrow("Invalid --reasoning");
});
