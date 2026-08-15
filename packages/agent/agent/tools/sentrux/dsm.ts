// agent/tools/sentrux/dsm.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSentrux } from "../../../lib/sentrux-tools";

export default defineTool({
  description: "Get the Design Structure Matrix for the scanned project: dependency matrix statistics and layering interpretation.",
  inputSchema: z.object({ format: z.enum(["text", "stats"]).optional() }),
  async execute(input) {
    return callSentrux("dsm", input);
  },
});