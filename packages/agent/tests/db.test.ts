import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { jsonValue, MIGRATE_SQL, migrate, type SqlExecutor } from "../lib/db";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  return { query: (text: string, params: unknown[] = []) => client.query(text, params) };
}

describe("jsonValue", () => {
  test("handles strings and objects", () => {
    expect(jsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(jsonValue({ a: 1 })).toEqual({ a: 1 });
    expect(jsonValue(null)).toBeNull();
  });
});

describe("migrate + schema", () => {
  test("creates ei_* tables and supports round-trips", async () => {
    const ex = await memExecutor();
    await migrate(ex);

    await ex.query(`insert into ei_providers (id, name, base_url, key_env) values ('groq', 'Groq', 'https://api.groq.com/openai/v1', 'PROVIDER_GROQ_API_KEY')`);
    const rows = await ex.query(`select id, name from ei_providers where id = $1`, ["groq"]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].name).toBe("Groq");

    await ex.query(`insert into ei_config (key, value, version) values ('active_model', $1::jsonb, 1)`, [
      JSON.stringify({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" }),
    ]);
    const cfg = await ex.query(`select value from ei_config where key = 'active_model'`);
    expect(jsonValue(cfg.rows[0].value)).toEqual({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" });

    // cascade delete: models cache follows the provider
    await ex.query(`insert into ei_models_cache (provider_id, model_id, source) values ('groq', 'm1', 'endpoint')`);
    await ex.query(`delete from ei_providers where id = 'groq'`);
    const left = await ex.query(`select count(*)::int as n from ei_models_cache`);
    expect(left.rows[0].n).toBe(0);
  });
});
