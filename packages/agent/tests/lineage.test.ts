import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, type SqlExecutor } from "../lib/db";
import { buildLineageDirective, nextLineageGeneration, selectLineageTarget } from "../lib/lineage";
import { PENDING_TTL_MS } from "../lib/gate";
import { appendLineageTag, createSchedule, getSchedule, updateSchedule } from "../lib/schedule-store";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

const OWNER = { principalId: "u1", guildId: "g1", channelId: "c1" };

async function seedRuns(ex: SqlExecutor, scheduleId: string, statuses: string[]): Promise<void> {
  for (let i = 0; i < statuses.length; i++) {
    await ex.query(
      `insert into ei_schedule_runs (id, schedule_id, status, started_at)
       values ($1, $2, $3, now() - ($4 || ' minutes')::interval)`,
      [`rl-${scheduleId}-${crypto.randomUUID()}`, scheduleId, statuses[i], statuses.length - i],
    );
  }
}

describe("selectLineageTarget", () => {
  test("returns null when the pending gate is live", async () => {
    const ex = await memExecutor();
    await createSchedule(ex, {
      name: "a",
      prompt: "p",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      owner: OWNER,
    });
    const pending = { scheduleId: "x", at: new Date().toISOString() };
    expect(await selectLineageTarget(ex, { now: new Date(), pending })).toBeNull();
  });

  test("targets again once the pending gate expired", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "a",
      prompt: "p",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      owner: OWNER,
    });
    await seedRuns(ex, s.id, ["succeeded"]);
    const expired = { scheduleId: "x", at: new Date(Date.now() - PENDING_TTL_MS - 1000).toISOString() };
    const target = await selectLineageTarget(ex, { now: new Date(), pending: expired });
    expect(target?.scheduleId).toBe(s.id);
  });

  test("picks worst health first (critical > degraded > stale > healthy)", async () => {
    const ex = await memExecutor();
    const healthy = await createSchedule(ex, { name: "h", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    const stale = await createSchedule(ex, { name: "s", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    const degraded = await createSchedule(ex, { name: "d", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    const critical = await createSchedule(ex, { name: "c", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    await seedRuns(ex, healthy.id, ["succeeded", "succeeded"]);
    await seedRuns(ex, stale.id, ["succeeded", "succeeded"]);
    await ex.query(`update ei_schedules set updated_at = now() - interval '20 days' where id = $1`, [stale.id]);
    await seedRuns(ex, degraded.id, ["succeeded", "failed", "failed", "succeeded", "failed", "failed"]);
    await seedRuns(ex, critical.id, ["failed", "failed", "failed"]);

    const target = await selectLineageTarget(ex, { now: new Date(), pending: null });
    expect(target?.scheduleId).toBe(critical.id);
  });

  test("excludes no-data schedules and schedules with a fresh lineage tag", async () => {
    const ex = await memExecutor();
    const noData = await createSchedule(ex, { name: "n", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    const marked = await createSchedule(ex, { name: "m", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    await seedRuns(ex, marked.id, ["succeeded"]);
    await appendLineageTag(ex, marked.id, "B");
    const target = await selectLineageTarget(ex, { now: new Date(), pending: null });
    expect(target?.scheduleId).not.toBe(noData.id);
    expect(target?.scheduleId).not.toBe(marked.id);
    expect(target).toBeNull();
  });

  test("returns null when nothing qualifies", async () => {
    const ex = await memExecutor();
    await createSchedule(ex, { name: "n", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    expect(await selectLineageTarget(ex, { now: new Date(), pending: null })).toBeNull();
  });
});

describe("buildLineageDirective", () => {
  test("contains the four variations and the wait-for-pick contract", () => {
    const text = buildLineageDirective({
      scheduleId: "s1",
      name: "digest",
      prompt: "Summarize my calendar",
      timezone: "UTC",
      health: "degraded",
      guildId: "g1",
      dmChannelId: "c1",
      dmThreadId: null,
    });
    expect(text).toContain("digest");
    expect(text).toContain("s1");
    expect(text).toContain("degraded");
    expect(text).toContain("Summarize my calendar");
    expect(text).toContain("A — better inputs/trigger");
    expect(text).toContain("B — sharper output/format");
    expect(text).toContain("C — more robust");
    expect(text).toContain("D — rethink the approach");
    expect(text).toContain("Make no changes — wait for my pick");
  });
});

describe("nextLineageGeneration + appendLineageTag", () => {
  test("generation counts up across appends and persists in tags", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, { name: "a", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    expect(nextLineageGeneration(null)).toBe(1);
    expect(nextLineageGeneration([])).toBe(1);

    await appendLineageTag(ex, s.id, "A");
    const afterOne = await getSchedule(ex, s.id);
    const tags1 = afterOne?.tags as Array<{ lineage?: { generation: number; variation: string; applied_at: string } }>;
    expect(tags1[0].lineage?.generation).toBe(1);
    expect(tags1[0].lineage?.variation).toBe("A");

    await appendLineageTag(ex, s.id, "C");
    const afterTwo = await getSchedule(ex, s.id);
    const tags2 = afterTwo?.tags as Array<{ lineage?: { generation: number; variation: string; applied_at: string } }>;
    expect(tags2).toHaveLength(2);
    expect(tags2[1].lineage?.generation).toBe(2);

    const marked = await updateSchedule(ex, s.id, { prompt: "new prompt" });
    expect(marked?.prompt).toBe("new prompt");
    expect((marked?.tags as unknown[]).length).toBe(2);
  });
});