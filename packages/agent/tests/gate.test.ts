import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, type SqlExecutor } from "../lib/db";
import { readGate, writeGate } from "../lib/gate";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

describe("ei_config gates", () => {
  test("readGate returns null when absent, then the written object", async () => {
    const ex = await memExecutor();
    expect(await readGate(ex, "health:last_report")).toBeNull();
    await writeGate(ex, "health:last_report", { hash: "abc", at: "2026-08-11T00:00:00.000Z" });
    expect(await readGate(ex, "health:last_report")).toEqual({ hash: "abc", at: "2026-08-11T00:00:00.000Z" });
  });

  test("writeGate overwrites and bumps version", async () => {
    const ex = await memExecutor();
    await writeGate(ex, "lineage:pending", { scheduleId: "s1", at: "a" });
    await writeGate(ex, "lineage:pending", { scheduleId: "s2", at: "b" });
    expect(await readGate(ex, "lineage:pending")).toEqual({ scheduleId: "s2", at: "b" });
    const r = await ex.query(`select version from ei_config where key = 'lineage:pending'`);
    expect(Number(r.rows[0].version)).toBe(2);
  });
});