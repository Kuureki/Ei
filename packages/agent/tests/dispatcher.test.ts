import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, type SqlExecutor } from "../lib/db";
import { createSchedule, getSchedule, triggerSchedule } from "../lib/schedule-store";
import { runDispatchCycle } from "../lib/schedule-dispatch";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

describe("dispatcher cycle", () => {
  test("runDispatchCycle claims, hands off, and completes a single job", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "job1",
      prompt: "p1",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      timezone: "UTC",
      firstRunAt: new Date(Date.now() - 60_000).toISOString(),
      owner: { principalId: "u1", guildId: "g1", channelId: "c1" },
    });
    const handed = await runDispatchCycle(ex, {
      now: new Date(),
      limit: 25,
      leaseForMs: 5 * 60_000,
      deliver: async (job) => job.prompt,
    });
    expect(handed).toHaveLength(1);
    expect(handed[0].name).toBe("job1");
    // The row is leased, so a second cycle in the same tick claims nothing.
    const again = await runDispatchCycle(ex, {
      now: new Date(),
      limit: 25,
      leaseForMs: 5 * 60_000,
      deliver: async (job) => job.prompt,
    });
    expect(again).toHaveLength(0);
  });

  test("auto-pauses a schedule after 3 consecutive delivery failures", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "flaky",
      prompt: "p",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      timezone: "UTC",
      owner: { principalId: "u1", guildId: "g1", channelId: "c1" },
    });
    // Three consecutive ticks, all failing delivery. Re-due between ticks
    // because a failed run advances next_run_at by the cadence.
    for (let i = 0; i < 3; i++) {
      await triggerSchedule(ex, s.id);
      await runDispatchCycle(ex, {
        now: new Date(),
        limit: 25,
        leaseForMs: 60_000,
        deliver: async () => {
          throw new Error("boom");
        },
      });
    }
    const row = await getSchedule(ex, s.id);
    expect(row?.enabled).toBe(false);
    // And a later cycle claims nothing for it.
    const after = await runDispatchCycle(ex, {
      now: new Date(),
      limit: 25,
      leaseForMs: 5 * 60_000,
      deliver: async () => {},
    });
    expect(after.some((j) => j.id === s.id)).toBe(false);
  });
});
