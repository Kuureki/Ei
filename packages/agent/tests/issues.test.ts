import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, type SqlExecutor } from "../lib/db";
import {
  findOpenIssue,
  listIssues,
  normalizeRootCause,
  openIssue,
  resolveIssue,
} from "../lib/issues";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

async function seedSchedule(ex: SqlExecutor, id = "s1"): Promise<void> {
  await ex.query(
    `insert into ei_schedules
      (id, name, prompt, cadence, next_run_at, owner_discord_id, guild_id, dm_channel_id)
     values ($1, $2, $3, 'every_minutes', now(), 'u1', 'g1', 'c1')`,
    [id, `job-${id}`, "p"],
  );
}

describe("issues store", () => {
  test("open → dedup → coalesce lifecycle", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex);

    const created = await openIssue(ex, {
      scheduleId: "s1",
      kind: "degraded",
      severity: "degraded",
      rootCause: "slow",
    });
    expect(created.changed).toBe(true);
    expect(created.issue.status).toBe("open");

    // Same kind+rootCause: dedup, no change.
    const same = await openIssue(ex, {
      scheduleId: "s1",
      kind: "degraded",
      severity: "degraded",
      rootCause: "slow",
    });
    expect(same.changed).toBe(false);
    expect(same.issue.id).toBe(created.issue.id);

    // Coalesce on severity change: same row, changed true.
    const worsened = await openIssue(ex, {
      scheduleId: "s1",
      kind: "degraded",
      severity: "critical",
      rootCause: "slow",
    });
    expect(worsened.changed).toBe(true);
    expect(worsened.issue.id).toBe(created.issue.id);
    expect(worsened.issue.severity).toBe("critical");

    // Different root cause: a second open row.
    const other = await openIssue(ex, {
      scheduleId: "s1",
      kind: "degraded",
      severity: "degraded",
      rootCause: "timeout",
    });
    expect(other.changed).toBe(true);
    expect(other.issue.id).not.toBe(created.issue.id);

    expect(await findOpenIssue(ex, "s1", "degraded", "slow")).not.toBeNull();
    expect(await findOpenIssue(ex, "s1", "degraded", "nope")).toBeNull();
  });

  test("resolveIssue transitions to resolved with by/resolved_at", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex);
    const { issue } = await openIssue(ex, {
      scheduleId: "s1",
      kind: "stale",
      severity: "warning",
      rootCause: "stale",
    });
    await resolveIssue(ex, issue.id, { by: "auto" });

    const open = await listIssues(ex, { status: "open" });
    expect(open).toHaveLength(0);
    const resolved = await listIssues(ex, { status: "resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolved_by).toBe("auto");
    expect(resolved[0].resolved_at).not.toBeNull();
  });

  test("listIssues is newest first", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex);
    await openIssue(ex, { scheduleId: "s1", kind: "degraded", severity: "degraded", rootCause: "a" });
    await openIssue(ex, { scheduleId: "s1", kind: "stale", severity: "warning", rootCause: "b" });
    const rows = await listIssues(ex);
    expect(rows).toHaveLength(2);
    expect(rows[0].root_cause).toBe("b");
  });

  test("normalizeRootCause strips % and trims to 200 chars", () => {
    expect(normalizeRootCause("100% failure", "x")).toBe("100 failure");
    expect(normalizeRootCause(null, "fallback")).toBe("fallback");
    expect(normalizeRootCause("a".repeat(300), "x").length).toBe(200);
  });

  test("schedule deletion cascades issue rows", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex);
    await openIssue(ex, { scheduleId: "s1", kind: "degraded", severity: "degraded", rootCause: "a" });
    await ex.query(`delete from ei_schedules where id = 's1'`);
    const left = await ex.query(`select count(*)::int as n from ei_issues`);
    expect(left.rows[0].n).toBe(0);
  });
});