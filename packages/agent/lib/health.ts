import { createHash } from "node:crypto";
import type { SqlExecutor } from "./db";
import {
  normalizeRootCause,
  openIssue,
  openIssuesForSchedule,
  resolveIssue,
  type IssueRow,
} from "./issues";

export type HealthStatus = "critical" | "degraded" | "stale" | "healthy" | "no-data";

export interface ScheduleHealth {
  scheduleId: string;
  name: string;
  prompt: string;
  timezone: string;
  guildId: string;
  dmChannelId: string;
  dmThreadId: string | null;
  status: HealthStatus;
  consecutiveFailures: number;
  successRate: number | null;
  totalRuns: number;
  lastError: string | null;
  daysSinceLastSuccess: number | null;
  daysSinceUpdated: number;
}

export interface IssueFinding {
  issue: IssueRow;
  schedule: ScheduleHealth;
}

export interface ReconcileResult {
  newOrChanged: IssueFinding[];
  resolved: string[];
}

const DAY_MS = 86_400_000;
const CRITICAL_FAILURES = 3;
const MODERATE_MIN_RUNS = 5;
const DEGRADED_RATE = 0.6;
const STALE_DAYS = 14;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function classify(runs: Array<{ status: string }>): { status: HealthStatus; consecutiveFailures: number; successRate: number | null } {
  if (runs.length === 0) return { status: "no-data", consecutiveFailures: 0, successRate: null };
  let consecutive = 0;
  for (const r of runs) {
    if (r.status === "failed") consecutive++;
    else break;
  }
  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  const successRate = succeeded / runs.length;
  if (consecutive >= CRITICAL_FAILURES) return { status: "critical", consecutiveFailures: consecutive, successRate };
  if (runs.length >= MODERATE_MIN_RUNS && successRate < DEGRADED_RATE) {
    return { status: "degraded", consecutiveFailures: consecutive, successRate };
  }
  return { status: "healthy", consecutiveFailures: consecutive, successRate };
}

export async function assessSchedules(ex: SqlExecutor, opts: { now: Date }): Promise<ScheduleHealth[]> {
  const now = opts.now;
  const r = await ex.query(`select * from schedules where enabled`);
  const out: ScheduleHealth[] = [];
  for (const raw of r.rows) {
    const scheduleId = String(raw.id);
    const runs = await ex.query(
      `select status, error, started_at from schedule_runs
       where schedule_id = $1 order by started_at desc limit 10`,
      [scheduleId],
    );
    const runRows = runs.rows.map((row) => ({
      status: String(row.status),
      error: row.error == null ? null : String(row.error),
      started_at: String(row.started_at),
    }));
    const { status, consecutiveFailures, successRate } = classify(runRows);
    const failedNewest = runRows.find((row) => row.status === "failed");
    const lastError = failedNewest?.error ? normalizeRootCause(failedNewest.error, status) : null;
    const lastSuccess = runRows.find((row) => row.status === "succeeded");
    const daysSinceLastSuccess = lastSuccess ? Math.max(0, daysBetween(new Date(lastSuccess.started_at), now)) : null;
    const daysSinceUpdated = Math.max(0, daysBetween(new Date(String(raw.updated_at)), now));

    let final: HealthStatus = status;
    if (status === "healthy" && daysSinceUpdated >= STALE_DAYS) final = "stale";

    out.push({
      scheduleId,
      name: String(raw.name),
      prompt: String(raw.prompt),
      timezone: String(raw.timezone),
      guildId: String(raw.guild_id),
      dmChannelId: String(raw.dm_channel_id),
      dmThreadId: raw.dm_thread_id == null ? null : String(raw.dm_thread_id),
      status: final,
      consecutiveFailures,
      successRate,
      totalRuns: runRows.length,
      lastError,
      daysSinceLastSuccess,
      daysSinceUpdated,
    });
  }
  return out;
}

function issueKindOf(status: HealthStatus): { kind: string; severity: string } | null {
  switch (status) {
    case "critical":
      return { kind: "consecutive-failures", severity: "critical" };
    case "degraded":
      return { kind: "degraded", severity: "degraded" };
    case "stale":
      return { kind: "stale", severity: "warning" };
    default:
      return null;
  }
}

// The only auto-mutation in the healing slice: opening/coalescing rows for
// unhealthy schedules and resolving rows when a schedule recovered.
export async function reconcileIssues(
  ex: SqlExecutor,
  assessments: ScheduleHealth[],
  opts: { now: Date },
): Promise<ReconcileResult> {
  void opts.now;
  const newOrChanged: IssueFinding[] = [];
  const resolved: string[] = [];
  for (const s of assessments) {
    const spec = issueKindOf(s.status);
    if (!spec) {
      for (const issue of await openIssuesForSchedule(ex, s.scheduleId)) {
        await resolveIssue(ex, issue.id, { by: "auto" });
        resolved.push(issue.id);
      }
      continue;
    }
    const detail: Record<string, unknown> = {
      name: s.name,
      totalRuns: s.totalRuns,
      consecutiveFailures: s.consecutiveFailures,
      successRate: s.successRate,
      daysSinceUpdated: s.daysSinceUpdated,
    };
    if (s.lastError) detail.lastError = s.lastError;
    const { issue, changed } = await openIssue(ex, {
      scheduleId: s.scheduleId,
      kind: spec.kind,
      severity: spec.severity,
      rootCause: s.lastError ?? spec.kind,
      detail,
    });
    const finding: IssueFinding = { issue, schedule: s };
    if (issue.status === "open") {
      if (changed) newOrChanged.push(finding);
    } else {
      resolved.push(issue.id);
    }
  }
  return { newOrChanged, resolved };
}

// Deterministic state fingerprint: scheduleId -> status, sorted, sha256 hex.
export function stableReportHash(assessments: ScheduleHealth[]): string {
  const map: Record<string, string> = {};
  for (const a of [...assessments].sort((x, y) => x.scheduleId.localeCompare(y.scheduleId))) {
    map[a.scheduleId] = a.status;
  }
  return createHash("sha256").update(JSON.stringify(map)).digest("hex").slice(0, 16);
}

const SYMPTOM_TEXT: Record<string, (s: ScheduleHealth) => string> = {
  critical: (s) => `${s.consecutiveFailures} consecutive failed runs`,
  degraded: (s) =>
    `a success rate of ${Math.round((s.successRate ?? 0) * 100)}% over the last ${s.totalRuns} runs`,
  stale: (s) => `${s.daysSinceUpdated} days without an update`,
};

export function buildHealthDirective(f: IssueFinding): string {
  const s = f.schedule;
  const symptom = SYMPTOM_TEXT[s.status]?.(s) ?? s.status;
  const errorLine = s.lastError ? `\nLast error: ${s.lastError}` : "";
  return [
    `Heads-up on your scheduled job "${s.name}" (health: ${s.status}).`,
    `Symptom: ${symptom}.${errorLine}`,
    `Current prompt: "${s.prompt}"`,
    "",
    "Draft 2–3 concrete options (pause, rewrite the prompt, adjust cadence, delete) with a one-line rationale each and a recommendation — then wait for my pick. Never apply a change yourself.",
  ].join("\n");
}