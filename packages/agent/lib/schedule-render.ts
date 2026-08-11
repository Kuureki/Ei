export interface ScheduleSummary {
  id: string;
  name: string;
  prompt: string;
  cadence: string;
  nextRun: string;
  enabled: boolean;
  lastRunStatus: string | null;
}

export function renderScheduleList(items: ScheduleSummary[]): string {
  if (items.length === 0) return "No scheduled jobs.";
  return items
    .map((s) => {
      const state = s.enabled ? "" : " [paused]";
      const last = s.lastRunStatus ? `, last: ${s.lastRunStatus}` : "";
      return `\`${s.name}\`${state} (${s.cadence}, next ${s.nextRun}${last}): ${s.prompt}`;
    })
    .join("\n");
}

export interface RunSummary {
  status: string;
  startedAt: string;
  finishedAt: string | null;
  output: string | null;
}

export function renderScheduleRuns(runs: RunSummary[]): string {
  if (runs.length === 0) return "No runs recorded for this job.";
  return runs
    .map((r, i) => {
      const status = r.status;
      const when = r.finishedAt ?? r.startedAt;
      return `${i + 1}. ${status} at ${when}${r.output ? ` — ${r.output}` : ""}`;
    })
    .join("\n");
}
