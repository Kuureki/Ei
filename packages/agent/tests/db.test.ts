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

    await ex.query(`insert into providers (id, name, base_url, key_env) values ('groq', 'Groq', 'https://api.groq.com/openai/v1', 'PROVIDER_GROQ_API_KEY')`);
    const rows = await ex.query(`select id, name from providers where id = $1`, ["groq"]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].name).toBe("Groq");

    await ex.query(`insert into config (key, value, version) values ('active_model', $1::jsonb, 1)`, [
      JSON.stringify({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" }),
    ]);
    const cfg = await ex.query(`select value from config where key = 'active_model'`);
    expect(jsonValue(cfg.rows[0].value)).toEqual({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" });

    // cascade delete: models cache follows the provider
    await ex.query(`insert into models_cache (provider_id, model_id, source) values ('groq', 'm1', 'endpoint')`);
    await ex.query(`delete from providers where id = 'groq'`);
    const left = await ex.query(`select count(*)::int as n from models_cache`);
    expect(left.rows[0].n).toBe(0);
  });

  test("creates schedules and schedule_runs with references", async () => {
    const ex = await memExecutor();
    await migrate(ex);

    await ex.query(
      `insert into schedules
        (id, name, prompt, cadence, every_minutes, next_run_at, owner_discord_id, guild_id, dm_channel_id)
       values ($1, $2, $3, $4, $5, now(), $6, $7, $8)`,
      ["s1", "remind", "Call the dentist", "every_minutes", 30, "u1", "g1", "c1"],
    );
    await ex.query(
      `insert into schedule_runs (id, schedule_id, status, output) values ('r1', 's1', 'succeeded', 'done')`,
    );
    const runs = await ex.query(`select * from schedule_runs where schedule_id = $1`, ["s1"]);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0].status).toBe("succeeded");

    // cascade delete: run rows follow the schedule
    await ex.query(`delete from schedules where id = 's1'`);
    const left = await ex.query(`select count(*)::int as n from schedule_runs`);
    expect(left.rows[0].n).toBe(0);
  });
});
