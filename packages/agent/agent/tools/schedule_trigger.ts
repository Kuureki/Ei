import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { triggerSchedule } from "../../lib/schedule-store";

export default defineTool({
  description: "Run a scheduled job immediately, out of band. The dispatcher picks it up within a minute.",
  inputSchema: z.object({ id: z.string().min(1) }),
  approval: always(),
  async execute(input) {
    const ex = getExecutor();
    if (!ex) throw new Error("scheduled jobs need Postgres");
    const res = await triggerSchedule(ex, input.id);
    return res.ok
      ? { triggered: true, message: `"${res.name}" will run within a minute.` }
      : { triggered: false, message: "No enabled schedule with that id/name." };
  },
});
