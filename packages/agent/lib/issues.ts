// issues adapter: durable rows for the self-healing loop.
// Detection-only by design: openIssue/coalesce + resolve are the only writes.
import { randomUUID } from "node:crypto";
import { jsonValue, type SqlExecutor } from "./db";

export interface IssueRow {
  id: string;
  schedule_id: string;
  kind: string;
  severity: string;
  status: string;
  root_cause: string;
  detail: unknown;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface OpenIssueInput {
  scheduleId: string;
  kind: string;
  severity: string;
  rootCause: string;
  detail?: Record<string, unknown>;
}

function rowOf(r: Record<string, unknown>): IssueRow {
  return {
    id: String(r.id),
    schedule_id: String(r.schedule_id),
    kind: String(r.kind),
    severity: String(r.severity),
    status: String(r.status),
    root_cause: String(r.root_cause),
    detail: jsonValue(r.detail),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    resolved_at: r.resolved_at == null ? null : String(r.resolved_at),
    resolved_by: r.resolved_by == null ? null : String(r.resolved_by),
  };
}

// Stable signature for dedup: '%'-stripped and capped at 200 chars.
export function normalizeRootCause(err: string | null | undefined, fallback: string): string {
  return (err ?? fallback).replace(/%/g, "").slice(0, 200);
}

export async function findOpenIssue(
  ex: SqlExecutor,
  scheduleId: string,
  kind: string,
  rootCause?: string,
): Promise<IssueRow | null> {
  if (rootCause === undefined) {
    const r = await ex.query(
      `select * from issues where schedule_id = $1 and kind = $2 and status = 'open' limit 1`,
      [scheduleId, kind],
    );
    return r.rows.length ? rowOf(r.rows[0]) : null;
  }
  const r = await ex.query(
    `select * from issues where schedule_id = $1 and kind = $2 and root_cause = $3 and status = 'open' limit 1`,
    [scheduleId, kind, rootCause],
  );
  return r.rows.length ? rowOf(r.rows[0]) : null;
}

// Insert when absent; coalesce (overwrite severity/detail, bump updated_at)
// when an open issue with the same schedule+kind+root_cause exists.
// `changed` is true only when the row was created or its visible state moved.
export async function openIssue(
  ex: SqlExecutor,
  input: OpenIssueInput,
): Promise<{ issue: IssueRow; changed: boolean }> {
  const existing = await findOpenIssue(ex, input.scheduleId, input.kind, input.rootCause);
  if (existing) {
    const detail = input.detail ?? (existing.detail as Record<string, unknown> | null) ?? {};
    const detailChanged = JSON.stringify(detail) !== JSON.stringify(existing.detail);
    const severityChanged = existing.severity !== input.severity;
    if (!detailChanged && !severityChanged) {
      return { issue: existing, changed: false };
    }
    const r = await ex.query(
      `update issues set severity = $1, detail = $2::jsonb, updated_at = now()
       where id = $3 returning *`,
      [input.severity, JSON.stringify(detail), existing.id],
    );
    return { issue: rowOf(r.rows[0]), changed: true };
  }
  const id = randomUUID();
  const detail = input.detail ?? {};
  await ex.query(
    `insert into issues (id, schedule_id, kind, severity, root_cause, detail)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id, input.scheduleId, input.kind, input.severity, input.rootCause, JSON.stringify(detail)],
  );
  const got = await findOpenIssue(ex, input.scheduleId, input.kind, input.rootCause);
  if (!got) throw new Error("issue write failed");
  return { issue: got, changed: true };
}

export async function resolveIssue(ex: SqlExecutor, issueId: string, opts: { by: string }): Promise<void> {
  await ex.query(
    `update issues set status = 'resolved', resolved_at = now(), resolved_by = $1 where id = $2`,
    [opts.by, issueId],
  );
}

export async function openIssuesForSchedule(ex: SqlExecutor, scheduleId: string): Promise<IssueRow[]> {
  const r = await ex.query(
    `select * from issues where schedule_id = $1 and status = 'open' order by updated_at desc`,
    [scheduleId],
  );
  return r.rows.map(rowOf);
}

export async function listIssues(ex: SqlExecutor, opts: { status?: "open" | "resolved" } = {}): Promise<IssueRow[]> {
  const where = opts.status ? `where status = $1` : "";
  const params = opts.status ? [opts.status] : [];
  const r = await ex.query(
    `select * from issues ${where} order by updated_at desc`,
    params as never[],
  );
  return r.rows.map(rowOf);
}