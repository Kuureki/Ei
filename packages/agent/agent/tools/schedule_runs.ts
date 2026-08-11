import { defineTool } from "eve/tools";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { listRuns } from "../../lib/schedule-store";
import { renderScheduleRuns } from "../../lib/schedule-render";

export default defineTool({
  description: "Show the recent runs of a scheduled job (status, timestamps, output). Use to answer 'what did that job do?'.",
  inputSchema: z.object({
    id: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(input) {
    const ex = getExecutor();
    if (!ex) throw new Error("scheduled jobs need Postgres");
    const rows = await listRuns(ex, input.id, input.limit ?? 3);
    return { runs: renderScheduleRuns(rows.map((r) => ({ status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, output: r.output }))) };
  },
});
