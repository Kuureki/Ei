// agent/tools/sentrux/test_gaps.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSentrux } from "../../../lib/sentrux-tools";

export default defineTool({
  description: "Find high-risk source files with no test coverage in the scanned project.",
  inputSchema: z.object({ limit: z.number().int().min(1).optional() }),
  async execute(input) {
    return callSentrux("test_gaps", input);
  },
});