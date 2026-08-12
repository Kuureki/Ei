// cli/commands/doctor.ts
import { existsSync } from "node:fs";
import path from "node:path";
import type { EiConfig } from "../config";
import { run, requireBin, type RunResult } from "../run";
import { openDb } from "../env";
import { resolveSentruxBin } from "../../lib/sentrux";
import { card, errorCard } from "../ui/card";
import { theme } from "../ui/theme";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Doctor check for the sentrux sensor binary (installed by `ei setup`). */
export async function checkSentrux(opts: {
  bin: string | null;
  run?: typeof run;
}): Promise<Check> {
  const runner = opts.run ?? run;
  if (!opts.bin) {
    return { name: "sentrux", ok: false, detail: "not installed (ei setup installs it)" };
  }
  // SENTRUX_SKIP_GRAMMAR_DOWNLOAD keeps first-run from pulling a ~30MB tarball.
  const version: RunResult = await runner([opts.bin, "--version"], {
    env: { SENTRUX_SKIP_GRAMMAR_DOWNLOAD: "1" },
  });
  const detail = version.ok ? version.stdout.trim().split("\n")[0] : "sentrux --version failed";
  return { name: "sentrux", ok: version.ok && detail.length > 0, detail };
}

export async function checkAll(
  cfg: EiConfig,
  opts: { run?: typeof run; requireBin?: typeof requireBin; sentruxBin?: string | null } = {},
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
  checks.push(await checkSentrux({ bin: opts.sentruxBin === undefined ? resolveSentruxBin() : opts.sentruxBin, run: runner }));
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
