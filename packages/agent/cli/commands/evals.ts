// cli/commands/evals.ts
import path from "node:path";
import type { EiConfig } from "../config";
import { runInteractive, requireBin } from "../run";
import { errorCard } from "../ui/card";

export async function evals(cfg: EiConfig, flags: Record<string, string | boolean>): Promise<number> {
  if (!requireBin("doppler")) {
    process.stderr.write(errorCard("evals", ["doppler required — evals need Doppler keys."]));
    return 1;
  }
  if (flags["dry-run"]) {
    process.stdout.write("would run: doppler run --project " + cfg.dopplerProject + " -- bash scripts/eval-ci.sh\n");
    return 0;
  }
  const code = await runInteractive(
    ["doppler", "run", "--project", cfg.dopplerProject, "--", "bash", "scripts/eval-ci.sh"],
    { cwd: cfg.checkoutPath },
  );
  return code === 0 ? 0 : 1;
}
