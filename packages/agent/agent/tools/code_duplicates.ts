import { defineTool } from "eve/tools";
import { z } from "zod";
import { runJscpd } from "../../lib/jscpd";

export default defineTool({
  description:
    "Find duplicated (copy-pasted) code blocks in a directory using jscpd. Returns the duplication percentage plus the largest clone locations as file:line ranges. Works on TypeScript, Rust, and most other languages. Use it to spot concrete refactoring opportunities.",
  inputSchema: z.object({
    path: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    minLines: z.number().int().min(3).optional(),
  }),
  async execute(input) {
    return runJscpd({ path: input.path, limit: input.limit ?? 25, minLines: input.minLines });
  },
});
