// agent/tools/sentrux/git_stats.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSentrux } from "../../../lib/sentrux-tools";

export default defineTool({
  description: "Git history analysis for the scanned project: churn, hotspots, bus factor, change coupling. Raw data, not a score.",
  inputSchema: z.object({ days: z.number().int().min(1).optional() }),
  async execute(input) {
    return callSentrux("git_stats", input);
  },
});