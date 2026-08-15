// agent/tools/sentrux/health.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSentrux } from "../../../lib/sentrux-tools";

export default defineTool({
  description:
    "Get the sentrux quality signal with root-cause breakdown (modularity, acyclicity, depth, equality, redundancy) and the single bottleneck to focus on.",
  inputSchema: z.object({}),
  async execute(input) {
    return callSentrux("health", input);
  },
});