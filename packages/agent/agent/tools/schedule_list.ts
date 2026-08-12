import { defineTool } from "eve/tools";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { listSchedules } from "../../lib/schedule-store";
import { formatNextRun } from "../../lib/schedule-admin";
import { renderScheduleList } from "../../lib/schedule-render";

export default defineTool({
  description: "List all scheduled jobs (id, name, cadence, next run, enabled, last status).",
  inputSchema: z.object({}),
  async execute() {
    const ex = getExecutor();
    const rows = await listSchedules(ex);
    return { schedules: renderScheduleList(rows.map((r) => ({ id: r.id, name: r.name, prompt: r.prompt, cadence: r.cadence, nextRun: formatNextRun(new Date(r.next_run_at), r.timezone), enabled: r.enabled, lastRunStatus: r.last_run_status }))) };
  },
});
