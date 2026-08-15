// agent/tools/sentrux/session_start.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSentrux } from "../../../lib/sentrux-tools";

export default defineTool({
  description: "Save the current sentrux health metrics as the baseline for a later session_end comparison.",
  inputSchema: z.object({}),
  async execute(input) {
    return callSentrux("session_start", input);
  },
});