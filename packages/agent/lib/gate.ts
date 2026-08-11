// ei_config-backed gates shared by the healing and lineage schedules.
import { jsonValue, type SqlExecutor } from "./db";

export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function readGate(ex: SqlExecutor, key: string): Promise<unknown> {
  const r = await ex.query(`select value from ei_config where key = $1`, [key]);
  if (!r.rows.length) return null;
  return jsonValue(r.rows[0].value);
}

export async function writeGate(ex: SqlExecutor, key: string, value: unknown): Promise<void> {
  await ex.query(
    `insert into ei_config (key, value, version) values ($1, $2::jsonb, 1)
     on conflict (key) do update set value = excluded.value, version = ei_config.version + 1`,
    [key, JSON.stringify(value)],
  );
}