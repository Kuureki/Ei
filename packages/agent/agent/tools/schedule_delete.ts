import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { deleteSchedule } from "../../lib/schedule-store";

export default defineTool({
  description: "Permanently delete a scheduled job and its run history.",
  inputSchema: z.object({ id: z.string().min(1) }),
  approval: always(),
  async execute(input) {
    const ex = getExecutor();
    if (!ex) throw new Error("scheduled jobs need Postgres");
    const row = await deleteSchedule(ex, input.id);
    if (!row) return { deleted: false, message: "No schedule with that id/name." };
    return { deleted: true, message: `Deleted "${row.name}".` };
  },
});
