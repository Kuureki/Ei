// cli/commands/status.ts
import type { SqlExecutor } from "../../lib/db";
import { getActiveModel, listProviders, cacheCounts } from "../../lib/providers";
import { listIssues } from "../../lib/issues";
import type { EiConfig } from "../config";
import { run } from "../run";
import { openDb, safeSecrets, mergedEnv } from "../env";
import { card } from "../ui/card";
import { theme } from "../ui/theme";

export interface StatusReport {
  health: { ok: boolean; detail: string };
  unit: { active: string; uptime: string; up: boolean };
  model: string;
  providers: { total: number; keysSet: number; active: string };
  schedules: number | null;
  issues: { open: number | null; detail: string };
  degraded: boolean;
}

function healthUrl(): string {
  const base = process.env.EVE_RUNTIME_URL || "http://127.0.0.1:3000";
  return `${base.replace(/\/+$/, "")}/eve/v1/health`;
}

type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export async function collectStatus(
  cfg: EiConfig,
  opts: { fetchImpl?: FetchLike; ex?: SqlExecutor | null } = {},
): Promise<StatusReport> {
  const f = opts.fetchImpl ?? fetch;
  let health = { ok: false, detail: "unreachable" };
  try {
    const res = await f(healthUrl(), { signal: AbortSignal.timeout(3000) });
    health = { ok: res.ok, detail: String(res.status) };
  } catch (err) {
    health = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const unitActive = await run(["systemctl", "is-active", cfg.unitName]);
  const uptimeRes = unitActive.ok
    ? await run(["systemctl", "show", "-p", "ActiveEnterTimestamp", "--value", cfg.unitName])
    : { stdout: "" } as { stdout: string };
  const unit = { active: unitActive.stdout.trim() || "inactive", uptime: uptimeRes.stdout.trim(), up: unitActive.ok };

  const ex = opts.ex !== undefined ? opts.ex : await openDb(cfg);
  const report: StatusReport = {
    health,
    unit,
    model: "unknown",
    providers: { total: 0, keysSet: 0, active: "—" },
    schedules: null,
    issues: { open: null, detail: "unknown" },
    degraded: true,
  };
  if (!ex) {
    report.degraded = !health.ok;
    return report;
  }
  try {
    const secrets = await safeSecrets(cfg);
    const env = mergedEnv(secrets);
    const active = await getActiveModel(ex);
    report.model = active ? `${active.provider_id}/${active.model_id}` : "fallback (none configured)";
    const providers = await listProviders(ex);
    report.providers = {
      total: providers.length,
      keysSet: providers.filter((p) => Boolean(env[p.key_env])).length,
      active: active?.provider_id ?? "—",
    };
    const sched = await ex.query(`select count(*)::int as n from schedules where enabled`);
    report.schedules = Number(sched.rows[0]?.n ?? 0);
    const issues = await listIssues(ex, { status: "open" });
    report.issues = { open: issues.length, detail: issues.length ? `${issues.length} open` : "none" };
    report.degraded = !health.ok || issues.length > 0;
  } catch {
    report.degraded = true;
  }
  return report;
}

export async function status(cfg: EiConfig, flags: Record<string, string | boolean>): Promise<number> {
  const report = await collectStatus(cfg);
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }
  const rows: { key: string; value: string; color?: (s: string) => string }[] = [
    { key: "Agent health", value: report.health.ok ? `● ok (${report.health.detail})` : `● ${report.health.detail}`, color: report.health.ok ? theme.ok : theme.err },
    { key: `Systemd ${cfg.unitName}`, value: report.unit.up ? report.unit.active : `${report.unit.active} (no systemd)`, color: report.unit.up ? theme.ok : theme.warn },
  ];
  if (report.unit.uptime) rows.push({ key: "Uptime", value: report.unit.uptime });
  rows.push(
    { key: "Active model", value: report.model, color: report.model.startsWith("fallback") ? theme.warn : undefined },
    { key: "Providers", value: `${report.providers.total} configured, ${report.providers.keysSet} keys set`, color: report.providers.keysSet ? theme.ok : theme.warn },
  );
  if (report.schedules !== null) rows.push({ key: "Schedules", value: `${report.schedules} enabled`, color: report.schedules ? theme.ok : theme.warn });
  rows.push({ key: "Open issues", value: report.issues.detail, color: report.issues.open ? theme.err : theme.ok });
  process.stdout.write(card(`Ei · status`, rows));
  return 0;
}
