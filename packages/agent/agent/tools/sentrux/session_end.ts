// agent/tools/sentrux/session_end.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSentrux } from "../../../lib/sentrux-tools";

export default defineTool({
  description: "Re-scan and compare against the saved baseline; returns pass/fail with the signal before/after and delta.",
  inputSchema: z.object({}),
  async execute(input) {
    return callSentrux("session_end", input);
  },
});