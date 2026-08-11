import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, type SqlExecutor } from "../lib/db";
import {
  claimDue,
  completeRun,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listRuns,
  listSchedules,
  updateSchedule,
} from "../lib/schedule-store";

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

describe("schedule-store", () => {
  test("create/list/get lifecycle", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "remind",
      prompt: "Call the dentist",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      owner: OWNER,
    });
    expect(s.id).toBeTruthy();
    expect(s.cadence).toBe("every_minutes");
    expect(await getSchedule(ex, "remind")).not.toBeNull();
    expect(await getSchedule(ex, s.id)).not.toBeNull();
    const rows = await listSchedules(ex);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("remind");
  });

  test("update toggles enabled and recomputes next_run_on cadence change", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "digest",
      prompt: "Digest calendar",
      cadence: { kind: "daily_at", time: "08:00" },
      timezone: "UTC",
      owner: OWNER,
    });
    const updated = await updateSchedule(ex, s.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    const moved = await updateSchedule(ex, s.id, { cadence: { kind: "every_minutes", everyMinutes: 60 } });
    expect(moved?.cadence).toBe("every_minutes");
    expect(moved?.every_minutes).toBe(60);
  });

  test("delete removes the schedule", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, { name: "x", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    expect((await deleteSchedule(ex, s.id))?.id).toBe(s.id);
    expect(await getSchedule(ex, s.id)).toBeNull();
  });

  test("claimDue leases due rows, creates running runs, and skips leased/future rows", async () => {
    const ex = await memExecutor();
    const due = await createSchedule(ex, {
      name: "due",
      prompt: "p1",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      timezone: "UTC",
      firstRunAt: new Date(Date.now() - 60_000).toISOString(),
      owner: OWNER,
    });
    const future = await createSchedule(ex, {
      name: "future",
      prompt: "p2",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      timezone: "UTC",
      firstRunAt: new Date(Date.now() + 60_000).toISOString(),
      owner: OWNER,
    });
    const now = new Date();
    const first = await claimDue(ex, { now, limit: 25, leaseForMs: 5 * 60_000 });
    expect(first).toHaveLength(1);
    expect(first[0].name).toBe("due");
    expect(first[0].runId).toBeTruthy();
    // Second claim (same tick) gets nothing: the row is leased.
    expect(await claimDue(ex, { now, limit: 25, leaseForMs: 5 * 60_000 })).toHaveLength(0);
    // The run row exists in 'running' state.
    const runs = await listRuns(ex, due.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("running");
  });

  test("completeRun records outcome and bumps schedule last_run fields", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "job",
      prompt: "p",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      timezone: "UTC",
      owner: OWNER,
    });
    await claimDue(ex, { now: new Date(), limit: 25, leaseForMs: 5 * 60_000 });
    const runs = await listRuns(ex, s.id, 10);
    await completeRun(ex, runs[0].id, { status: "succeeded", output: "done", sessionId: "sess1" });
    const after = await listRuns(ex, s.id, 10);
    expect(after[0].status).toBe("succeeded");
    expect(after[0].output).toBe("done");
    const row = await getSchedule(ex, s.id);
    expect(row?.last_run_status).toBe("succeeded");
    expect(row?.last_run_output).toBe("done");
    expect(row?.run_count).toBe(1);
  });
});
