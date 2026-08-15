// agent/tools/sentrux/check_rules.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSentrux } from "../../../lib/sentrux-tools";

export default defineTool({
  description: "Check the .sentrux/rules.toml architectural constraints for the scanned project; returns pass/fail with violations.",
  inputSchema: z.object({}),
  async execute(input) {
    return callSentrux("check_rules", input);
  },
});