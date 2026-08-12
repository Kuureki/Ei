// cli/commands/doctor.ts
import { existsSync } from "node:fs";
import path from "node:path";
import type { EiConfig } from "../config";
import { run, requireBin, type RunResult } from "../run";
import { openDb } from "../env";
import { card, errorCard } from "../ui/card";
import { theme } from "../ui/theme";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function checkAll(
  cfg: EiConfig,
  opts: { run?: typeof run; requireBin?: typeof requireBin } = {},
): Promise<Check[]> {
  const bin = opts.requireBin ?? requireBin;
  const runner = opts.run ?? run;
  const checks: Check[] = [];
  for (const name of ["bun", "git", "doppler"]) {
    checks.push({ name, ok: bin(name), detail: bin(name) ? "" : "not on PATH" });
  }
  checks.push({
    name: "checkout",
    ok: existsSync(path.join(cfg.checkoutPath, ".git")),
    detail: existsSync(path.join(cfg.checkoutPath, ".git")) ? cfg.checkoutPath : `no .git at ${cfg.checkoutPath}`,
  });
  const unitActive: RunResult = await runner(["systemctl", "is-active", cfg.unitName]);
  const unitEnabled: RunResult = await runner(["systemctl", "is-enabled", cfg.unitName]);
  checks.push({
    name: `systemd ${cfg.unitName}`,
    ok: unitActive.ok && unitEnabled.ok,
    detail: `${unitActive.stdout.trim() || "inactive"} / ${unitEnabled.stdout.trim() || "not a systemd host"}`,
  });
  const db = await openDb(cfg);
  checks.push({
    name: "postgres",
    ok: db !== null,
    detail: db ? "reachable via doppler" : "no WORKFLOW_POSTGRES_URL in doppler",
  });
  return checks;
}

export async function doctor(cfg: EiConfig, flags: Record<string, string | boolean>): Promise<number> {
  const checks = await checkAll(cfg);
  if (flags.json) {
    process.stdout.write(JSON.stringify(checks, null, 2) + "\n");
    return 0;
  }
  const allOk = checks.every((c) => c.ok);
  process.stdout.write(
    card(allOk ? "ei doctor — all good" : "ei doctor — problems found", checks.map((c) => ({
      key: c.name,
      value: c.ok ? "ok" : (c.detail || "failed"),
      color: c.ok ? theme.ok : theme.err,
    }))),
  );
  if (!allOk) process.stderr.write(errorCard("doctor", ["Fix the items above, then run ei doctor again."]));
  return 0;
}
