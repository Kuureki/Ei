import type { SqlExecutor } from "./db";
import { claimDue, completeRun, type ClaimedSchedule } from "./schedule-store";

export interface DispatchOptions {
  now: Date;
  limit: number;
  leaseForMs: number;
  deliver: (job: ClaimedSchedule) => Promise<unknown> | unknown;
}

const PAUSE_AFTER_CONSECUTIVE_FAILURES = 3;

export async function runDispatchCycle(ex: SqlExecutor, opts: DispatchOptions): Promise<ClaimedSchedule[]> {
  const jobs = await claimDue(ex, { now: opts.now, limit: opts.limit, leaseForMs: opts.leaseForMs });
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await opts.deliver(job);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message.slice(0, 1000) : String(err);
        await completeRun(ex, job.runId, { status: "failed", error: errMsg });
        // Auto-pause after N consecutive failures (spec §6): inspect the
        // newest runs for this schedule; a success in the streak resets it.
        const rows = await ex.query(
          `select id, status from schedule_runs
           where schedule_id = $1
           order by started_at desc
           limit $2`,
          [job.id, PAUSE_AFTER_CONSECUTIVE_FAILURES],
        );
        const allFailed =
          rows.rows.length >= PAUSE_AFTER_CONSECUTIVE_FAILURES &&
          rows.rows.every((r) => String(r.status) === "failed");
        if (allFailed) {
          await ex.query(`update schedules set enabled = false where id = $1`, [job.id]);
        }
      }
    }),
  );
  return jobs;
}
