// agent/tools/sentrux/scan.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSentrux } from "../../../lib/sentrux-tools";

export default defineTool({
  description:
    "Scan a directory and compute all sentrux metrics. Must be called before the other sentrux tools. Returns the quality signal (0-10000) plus file/line/edge counts.",
  inputSchema: z.object({ path: z.string().min(1) }),
  async execute(input) {
    return callSentrux("scan", input);
  },
});