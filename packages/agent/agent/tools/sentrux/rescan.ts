// agent/tools/sentrux/rescan.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSentrux } from "../../../lib/sentrux-tools";

export default defineTool({
  description: "Re-scan the directory from a previous sentrux scan to pick up file changes since then.",
  inputSchema: z.object({}),
  async execute(input) {
    return callSentrux("rescan", input);
  },
});