// cli/commands/logs.ts
import { spawn } from "node:child_process";
import type { EiConfig } from "../config";
import { requireBin } from "../run";
import { errorCard } from "../ui/card";

export async function logs(cfg: EiConfig, flags: Record<string, string | boolean>): Promise<number> {
  if (!requireBin("journalctl")) {
    process.stderr.write(errorCard("logs", ["journalctl not found — systemd host required.", "Hint: run the agent with `doppler run --project ei --config prd -- bunx eve start` and read its output."]));
    return 1;
  }
  const lines = typeof flags.lines === "string" ? Number(flags.lines) : 100;
  const args = ["-u", cfg.unitName, "-n", String(lines)];
  if (flags.follow) args.push("-f");
  return new Promise((resolve) => {
    const child = spawn("journalctl", args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code === 0 ? 0 : 1));
    child.on("error", () => resolve(1));
  });
}
