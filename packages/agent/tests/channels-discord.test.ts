import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { decodeToken, encodeToken } from "@ei/shared";
import { migrate, type SqlExecutor } from "../lib/db";
import { completeRun, listRuns } from "../lib/schedule-store";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

describe("channels/discord scheduleRunId handle", () => {
  test("message.completed writes a succeeded run when scheduleRunId is present", async () => {
    const ex = await memExecutor();
    const scheduleId = "s1";

    const addr = { guildId: "g1", channelId: "c1", threadId: "t1", scheduleRunId: "r1" };
    const token = encodeToken(addr);
    const decoded = decodeToken(token);
    expect(decoded).toEqual(addr);

    // A fake dispatch: 'r1' must exist as a run row for completeRun to bump the schedule.
    await ex.query(
      `insert into ei_schedules (id, name, prompt, cadence, next_run_at, owner_discord_id, guild_id, dm_channel_id)
       values ($1, $2, $3, 'daily_at', now(), 'u1', 'g1', 'c1')`,
      [scheduleId, "remind", "p"],
    );
    await ex.query(`insert into ei_schedule_runs (id, schedule_id, status) values ('r1', $1, 'running')`, [scheduleId]);
    await completeRun(ex, "r1", { status: "succeeded", output: "done", sessionId: "s1" });

    const runs = await listRuns(ex, scheduleId, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
  });
});
