// ei_schedules + ei_schedule_runs adapter over the repo's SqlExecutor.
// Atomically leases due rows so overlapping dispatcher ticks never claim twice.
import { randomUUID } from "node:crypto";
import { jsonValue, type SqlExecutor } from "./db";
import { nextLineageGeneration } from "./lineage";
import { computeNextRun, validateCadence, type ScheduledCadenceInput } from "./schedule-admin";

export interface ScheduleRow {
  id: string;
  name: string;
  prompt: string;
  cadence: string;
  every_minutes: number | null;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_output: string | null;
  run_count: number;
  owner_discord_id: string;
  guild_id: string;
  dm_channel_id: string;
  dm_thread_id: string | null;
  tags: unknown;
  created_by: string | null;
}

export interface CreateScheduleInput {
  name: string;
  prompt: string;
  cadence: ScheduledCadenceInput;
  timezone?: string;
  firstRunAt?: string;
  tags?: string[];
  owner: { principalId: string; guildId: string; channelId: string; threadId?: string };
}

export interface ClaimedSchedule {
  id: string;
  name: string;
  prompt: string;
  runId: string;
  guild_id: string;
  dm_channel_id: string;
  dm_thread_id: string | null;
  cadence: ScheduledCadenceInput;
}

export interface RunRow {
  id: string;
  schedule_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  output: string | null;
  error: string | null;
  session_id: string | null;
}

function rowOf(r: Record<string, unknown>): ScheduleRow {
  return {
    id: String(r.id),
    name: String(r.name),
    prompt: String(r.prompt),
    cadence: String(r.cadence),
    every_minutes: r.every_minutes == null ? null : Number(r.every_minutes),
    cron: r.cron == null ? null : String(r.cron),
    timezone: String(r.timezone),
    enabled: Boolean(r.enabled),
    next_run_at: String(r.next_run_at),
    last_run_at: r.last_run_at == null ? null : String(r.last_run_at),
    last_run_status: r.last_run_status == null ? null : String(r.last_run_status),
    last_run_output: r.last_run_output == null ? null : String(r.last_run_output),
    run_count: Number(r.run_count ?? 0),
    owner_discord_id: String(r.owner_discord_id),
    guild_id: String(r.guild_id),
    dm_channel_id: String(r.dm_channel_id),
    dm_thread_id: r.dm_thread_id == null ? null : String(r.dm_thread_id),
    tags: jsonValue(r.tags),
    created_by: r.created_by == null ? null : String(r.created_by),
  };
}

function cadenceOf(row: ScheduleRow): ScheduledCadenceInput {
  switch (row.cadence) {
    case "every_minutes":
      return { kind: "every_minutes", everyMinutes: row.every_minutes ?? 30 };
    case "daily_at":
      return { kind: "daily_at", time: row.cron ?? "00:00" };
    case "weekly_on": {
      // cron stores `HH:MM:1,3` (time + comma-separated weekdays).
      const idx = (row.cron ?? "00:00").lastIndexOf(":");
      const timePart = idx > 0 ? (row.cron ?? "00:00").slice(0, idx) : "00:00";
      const weekPart = idx > 0 ? (row.cron ?? "00:00").slice(idx + 1) : "";
      const weekly = weekPart ? weekPart.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [];
      return { kind: "weekly_on", time: timePart, weekly };
    }
    case "monthly_on": {
      // cron stores `DAY:HH:MM`.
      const m = (row.cron ?? "1:00:00").match(/^(\d{1,2}):([0-2]\d:[0-5]\d)$/);
      return { kind: "monthly_on", dayOfMonth: m ? Number(m[1]) : 1, time: m ? m[2] : "00:00" };
    }
    default:
      return { kind: "every_minutes", everyMinutes: 30 };
  }
}

export async function createSchedule(ex: SqlExecutor, input: CreateScheduleInput): Promise<ScheduleRow> {
  const id = randomUUID();
  const tz = input.timezone ?? "UTC";
  validateCadence(input.cadence);
  // firstRunAt (when given) is the trigger instant verbatim; without it the
  // schedule is due immediately on the next tick. computeNextRun only drives
  // recurrence (see completeRun).
  const from = input.firstRunAt ? new Date(input.firstRunAt) : new Date();
  const tags = input.tags ?? [];
  await ex.query(
    `insert into ei_schedules
      (id, name, prompt, cadence, every_minutes, cron, timezone, next_run_at, owner_discord_id, guild_id, dm_channel_id, dm_thread_id, tags, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
    [
      id,
      input.name,
      input.prompt,
      input.cadence.kind,
      input.cadence.kind === "every_minutes" ? input.cadence.everyMinutes : null,
      encodeCadenceValue(input.cadence),
      tz,
      from.toISOString(),
      input.owner.principalId,
      input.owner.guildId,
      input.owner.channelId,
      input.owner.threadId ?? null,
      JSON.stringify(tags),
      input.owner.principalId,
    ],
  );
  const got = await getSchedule(ex, id);
  if (!got) throw new Error("schedule write failed");
  return got;
}

export async function listSchedules(ex: SqlExecutor): Promise<ScheduleRow[]> {
  const r = await ex.query(`select * from ei_schedules order by next_run_at`);
  return r.rows.map(rowOf);
}

export async function getSchedule(ex: SqlExecutor, idOrName: string): Promise<ScheduleRow | null> {
  const r = await ex.query(`select * from ei_schedules where id = $1 or name = $1 limit 1`, [idOrName]);
  return r.rows.length ? rowOf(r.rows[0]) : null;
}

export async function updateSchedule(
  ex: SqlExecutor,
  idOrName: string,
  patch: { prompt?: string; cadence?: ScheduledCadenceInput; timezone?: string; enabled?: boolean; name?: string; tags?: string[] },
): Promise<ScheduleRow | null> {
  const existing = await getSchedule(ex, idOrName);
  if (!existing) return null;
  const tz = patch.timezone ?? existing.timezone;
  const cadence = patch.cadence ?? cadenceOf(existing);
  const next = computeNextRun(new Date(existing.next_run_at), cadence, tz);
  const fields: string[] = [];
  const values: unknown[] = [];
  const push = (col: string, v: unknown) => {
    fields.push(`${col} = $${values.length + 1}`);
    values.push(v);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.prompt !== undefined) push("prompt", patch.prompt);
  if (patch.cadence !== undefined) {
    push("cadence", cadence.kind);
    push("every_minutes", cadence.kind === "every_minutes" ? cadence.everyMinutes : null);
    push("cron", encodeCadenceValue(cadence));
  }
  if (patch.timezone !== undefined) push("timezone", tz);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.tags !== undefined) push("tags", JSON.stringify(patch.tags));
  values.push(next.toISOString());
  fields.push(`next_run_at = $${values.length}`, `updated_at = now()`);
  await ex.query(`update ei_schedules set ${fields.join(", ")} where id = $${values.length + 1}`, [...values, existing.id]);
  return getSchedule(ex, existing.id);
}

export async function deleteSchedule(ex: SqlExecutor, idOrName: string): Promise<ScheduleRow | null> {
  const existing = await getSchedule(ex, idOrName);
  if (!existing) return null;
  await ex.query(`delete from ei_schedules where id = $1`, [existing.id]);
  return existing;
}

export async function triggerSchedule(ex: SqlExecutor, idOrName: string): Promise<{ ok: boolean; name?: string }> {
  const r = await ex.query(
    `update ei_schedules set next_run_at = now(), locked_until = null, locked_by = null
     where id = $1 and enabled returning *`,
    [idOrName],
  );
  if (!r.rows.length) {
    // Try by name.
    const byName = await ex.query(
      `update ei_schedules set next_run_at = now(), locked_until = null, locked_by = null
       where name = $1 and enabled returning *`,
      [idOrName],
    );
    if (!byName.rows.length) return { ok: false };
    return { ok: true, name: String(byName.rows[0].name) };
  }
  return { ok: true, name: String(r.rows[0].name) };
}

// Atomic lease: claim due, enabled rows whose lock expired. Pure SQL so
// overlapping ticks never double-claim. Creates one 'running' run row per claim.
export async function claimDue(
  ex: SqlExecutor,
  opts: { now: Date; limit: number; leaseForMs: number },
): Promise<ClaimedSchedule[]> {
  const nowIso = opts.now.toISOString();
  const lockUntil = new Date(opts.now.getTime() + opts.leaseForMs).toISOString();
  const r = await ex.query(
    `update ei_schedules
       set locked_until = $1, locked_by = $2, last_run_at = now()
     where id in (
       select id from ei_schedules
       where enabled and next_run_at <= $3 and (locked_until is null or locked_until < $3)
       order by next_run_at
       limit $4
     )
     returning *`,
    [lockUntil, "dispatcher", nowIso, opts.limit],
  );
  const claimed: ClaimedSchedule[] = [];
  for (const row of r.rows) {
    const s = rowOf(row);
    const runId = randomUUID();
    await ex.query(
      `insert into ei_schedule_runs (id, schedule_id, status) values ($1, $2, 'running')`,
      [runId, s.id],
    );
    claimed.push({
      id: s.id,
      name: s.name,
      prompt: s.prompt,
      runId,
      guild_id: s.guild_id,
      dm_channel_id: s.dm_channel_id,
      dm_thread_id: s.dm_thread_id,
      cadence: cadenceOf(s),
    });
  }
  return claimed;
}

export async function completeRun(
  ex: SqlExecutor,
  runId: string,
  outcome: { status: "succeeded" | "failed" | "skipped"; output?: string; error?: string; sessionId?: string },
): Promise<void> {
  // The run row (started_at) anchors recurrence: the next run fires one full
  // cadence after this run *started*, not after it finished.
  const runRow = await ex.query(`select schedule_id, started_at from ei_schedule_runs where id = $1`, [runId]);
  if (!runRow.rows.length) return;
  const scheduleId = String(runRow.rows[0].schedule_id);
  const startedAt = new Date(String(runRow.rows[0].started_at));

  await ex.query(
    `update ei_schedule_runs
       set status = $2, finished_at = now(), output = $3, error = $4, session_id = $5
     where id = $1`,
    [runId, outcome.status, outcome.output ?? null, outcome.error ?? null, outcome.sessionId ?? null],
  );

  // Advance recurrence: next run = cadence after this run's start. Disabled
  // schedules keep their (future) next_run_at so re-enabling resumes cleanly.
  const schedule = await getSchedule(ex, scheduleId);
  if (schedule) {
    const next = computeNextRun(startedAt, cadenceOf(schedule), schedule.timezone);
    await ex.query(
      `update ei_schedules
         set last_run_status = $2, last_run_output = $3, run_count = run_count + 1,
             last_run_at = now(), locked_until = null, locked_by = null,
             next_run_at = case when enabled then $4 else next_run_at end
       where id = $1`,
      [scheduleId, outcome.status, outcome.output ?? null, next.toISOString()],
    );
  }
}

export async function listRuns(ex: SqlExecutor, scheduleId: string, limit = 3): Promise<RunRow[]> {
  const r = await ex.query(
    `select * from ei_schedule_runs where schedule_id = $1 order by started_at desc limit $2`,
    [scheduleId, limit],
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    schedule_id: String(row.schedule_id),
    started_at: String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
    status: String(row.status),
    output: row.output == null ? null : String(row.output),
    error: row.error == null ? null : String(row.error),
    session_id: row.session_id == null ? null : String(row.session_id),
  }));
}

// Append a {lineage: {generation, variation, applied_at}} marker to the
// schedule's tags jsonb (autoresearch lineage bookkeeping).
export async function appendLineageTag(
  ex: SqlExecutor,
  idOrName: string,
  variation: string,
): Promise<ScheduleRow | null> {
  const existing = await getSchedule(ex, idOrName);
  if (!existing) return null;
  const tags = Array.isArray(existing.tags) ? (existing.tags as unknown[]) : [];
  tags.push({
    lineage: { generation: nextLineageGeneration(existing.tags), variation, applied_at: new Date().toISOString() },
  });
  await ex.query(
    `update ei_schedules set tags = $1::jsonb, updated_at = now() where id = $2`,
    [JSON.stringify(tags), existing.id],
  );
  return getSchedule(ex, existing.id);
}

// Serialize a cadence into `every_minutes`/`cron` columns:
//  - every_minutes: minutes int
//  - daily_at:      `HH:MM`
//  - weekly_on:     `HH:MM:1,3` (time + comma-separated weekdays)
//  - monthly_on:    `DAY:HH:MM`
function encodeCadenceValue(c: ScheduledCadenceInput): string | null {
  switch (c.kind) {
    case "every_minutes":
      return null;
    case "daily_at":
      return c.time;
    case "weekly_on":
      return `${c.time}:${c.weekly.join(",")}`;
    case "monthly_on":
      return `${c.dayOfMonth}:${c.time}`;
  }
}
