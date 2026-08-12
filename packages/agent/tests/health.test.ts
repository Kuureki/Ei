import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, type SqlExecutor } from "../lib/db";
import {
  assessSchedules,
  buildHealthDirective,
  reconcileIssues,
  stableReportHash,
} from "../lib/health";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

async function seedSchedule(
  ex: SqlExecutor,
  opts: { id?: string; enabled?: boolean; updatedAtDaysAgo?: number } = {},
): Promise<void> {
  const id = opts.id ?? "s1";
  const updated = new Date(Date.now() - (opts.updatedAtDaysAgo ?? 0) * 86_400_000).toISOString();
  await ex.query(
    `insert into schedules
      (id, name, prompt, cadence, next_run_at, owner_discord_id, guild_id, dm_channel_id, enabled, updated_at)
     values ($1, $2, 'prompt text', 'every_minutes', now(), 'u1', 'g1', 'c1', $3, $4::timestamptz)`,
    [id, `job-${id}`, opts.enabled ?? true, updated],
  );
}

async function seedRuns(ex: SqlExecutor, scheduleId: string, statuses: string[]): Promise<void> {
  for (let i = 0; i < statuses.length; i++) {
    const started = new Date(Date.now() - (statuses.length - i) * 60_000).toISOString();
    await ex.query(
      `insert into schedule_runs (id, schedule_id, status, error, started_at)
       values ($1, $2, $3, $4, $5::timestamptz)`,
      [`r-${scheduleId}-${crypto.randomUUID()}`, scheduleId, statuses[i], statuses[i] === "failed" ? "boom 100%" : null, started],
    );
  }
}

async function statusOf(ex: SqlExecutor, scheduleId: string): Promise<string> {
  const rows = await assessSchedules(ex, { now: new Date() });
  return rows.find((r) => r.scheduleId === scheduleId)?.status ?? "absent";
}

describe("assessSchedules classification", () => {
  test("3 trailing failed runs -> critical", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex, { id: "s1" });
    await seedRuns(ex, "s1", ["succeeded", "failed", "failed", "failed"]);
    expect(await statusOf(ex, "s1")).toBe("critical");
  });

  test("success rate under 0.6 over >= 5 runs -> degraded", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex, { id: "s2" });
    await seedRuns(ex, "s2", ["succeeded", "failed", "failed", "succeeded", "failed", "failed"]);
    expect(await statusOf(ex, "s2")).toBe("degraded");
  });

  test("healthy runs but updated 20 days ago -> stale", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex, { id: "s3", updatedAtDaysAgo: 20 });
    await seedRuns(ex, "s3", ["succeeded", "succeeded", "succeeded"]);
    expect(await statusOf(ex, "s3")).toBe("stale");
  });

  test("fresh healthy runs -> healthy", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex, { id: "s4" });
    await seedRuns(ex, "s4", ["succeeded", "succeeded"]);
    expect(await statusOf(ex, "s4")).toBe("healthy");
  });

  test("no runs -> no-data; disabled schedules excluded", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex, { id: "s5" });
    await seedSchedule(ex, { id: "s6", enabled: false });
    await seedRuns(ex, "s6", ["failed", "failed", "failed"]);
    const rows = await assessSchedules(ex, { now: new Date() });
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduleId).toBe("s5");
    expect(rows[0].status).toBe("no-data");
  });
});

describe("reconcileIssues", () => {
  test("opens a row for a critical schedule; steady state is silent", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex, { id: "s1" });
    await seedRuns(ex, "s1", ["failed", "failed", "failed"]);
    const assessments = await assessSchedules(ex, { now: new Date() });

    const first = await reconcileIssues(ex, assessments, { now: new Date() });
    expect(first.newOrChanged).toHaveLength(1);
    expect(first.newOrChanged[0].issue.kind).toBe("consecutive-failures");
    expect(first.newOrChanged[0].issue.root_cause).toBe("boom 100"); // '%' stripped

    const second = await reconcileIssues(ex, assessments, { now: new Date() });
    expect(second.newOrChanged).toHaveLength(0);
  });

  test("a recovered schedule resolves its open issue (by auto)", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex, { id: "s1" });
    await seedRuns(ex, "s1", ["failed", "failed", "failed"]);
    const bad = await assessSchedules(ex, { now: new Date() });
    await reconcileIssues(ex, bad, { now: new Date() });

    await seedRuns(ex, "s1", ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
    const recovered = await reconcileIssues(ex, await assessSchedules(ex, { now: new Date() }), {
      now: new Date(),
    });
    expect(recovered.resolved).toHaveLength(1);
    const rows = await ex.query(`select status, resolved_by from issues`);
    expect(String(rows.rows[0].status)).toBe("resolved");
    expect(String(rows.rows[0].resolved_by)).toBe("auto");
  });
});

describe("stableReportHash", () => {
  test("same severities -> same hash; different -> different", async () => {
    const a = [{ scheduleId: "s1", status: "critical" }] as never;
    const b = [{ scheduleId: "s1", status: "critical" }] as never;
    const c = [{ scheduleId: "s1", status: "healthy" }] as never;
    expect(stableReportHash(a as never[])).toBe(stableReportHash(b as never[]));
    expect(stableReportHash(a as never[])).not.toBe(stableReportHash(c as never[]));
  });
});

describe("buildHealthDirective", () => {
  test("names the schedule, symptom, prompt, and the wait-for-pick contract", async () => {
    const ex = await memExecutor();
    await seedSchedule(ex, { id: "s1" });
    await seedRuns(ex, "s1", ["failed", "failed", "failed"]);
    const assessments = await assessSchedules(ex, { now: new Date() });
    const { newOrChanged } = await reconcileIssues(ex, assessments, { now: new Date() });
    const text = buildHealthDirective(newOrChanged[0]);
    expect(text).toContain("job-s1");
    expect(text).toContain("3 consecutive failed runs");
    expect(text).toContain("prompt text");
    expect(text).toContain("Never apply a change yourself");
    expect(text).toContain("boom 100");
  });
});