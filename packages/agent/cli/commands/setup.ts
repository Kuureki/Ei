// cli/commands/setup.ts
import path from "node:path";
import type { EiConfig } from "../config";
import { writeConfig } from "../config";
import { run, runInteractive, requireBin } from "../run";
import { runStep, plugStep } from "../ui/step";
import { confirm } from "../ui/prompts";
import { errorCard, card } from "../ui/card";
import { theme } from "../ui/theme";
import { defaultEnvSyncDeps, syncEnv } from "../env-sync";

export type SetupAction =
  | "preflight"
  | "doppler-project"
  | "env-sync"
  | "install"
  | "postgres-schema"
  | "typecheck"
  | "build"
  | "register"
  | "write-config"
  | "systemd"
  | "start";

export interface SetupStep {
  label: string;
  action: SetupAction;
}

export function planSetup(
  cfg: EiConfig,
  opts: { hasSystemd?: boolean } = {},
): SetupStep[] {
  const hasSystemd = opts.hasSystemd ?? Boolean(requireBin("systemctl"));
  return [
    { label: "Preflight", action: "preflight" },
    { label: "doppler project + config", action: "doppler-project" },
    { label: "sync env to doppler", action: "env-sync" },
    { label: "bun install", action: "install" },
    { label: "postgres schema", action: "postgres-schema" },
    { label: "typecheck", action: "typecheck" },
    { label: "build:agent", action: "build" },
    { label: "register-commands", action: "register" },
    { label: "write config", action: "write-config" },
    {
      label: hasSystemd ? "systemd unit" : "systemd unit (manual instructions)",
      action: "systemd",
    },
    { label: "start + health", action: "start" },
  ];
}

function unitFile(cfg: EiConfig, user: string, bunBinDir: string): string {
  return `[Unit]
Description=ei personal agent (eve + discord gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${cfg.checkoutPath}/packages/agent
Environment=PATH=${bunBinDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/doppler run --project ${cfg.dopplerProject} --config ${cfg.dopplerConfig} -- ${bunBinDir}/bun x eve start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

async function resolveBunBinDir(): Promise<string> {
  const r = await run(["sh", "-lc", "command -v bunx"]);
  if (r.ok && r.stdout.trim()) return path.dirname(r.stdout.trim());
  return "/root/.bun/bin";
}

// eve's CLI bin shebangs `#!/usr/bin/env node`; system node on most hosts is
// <24 and eve rejects it. Point `node` at bun (which reports Node >=24) so the
// shebang resolves inside the unit's PATH instead of /usr/bin.
async function ensureNodeAlias(bunBinDir: string): Promise<void> {
  await run(["ln", "-sf", "bun", path.join(bunBinDir, "node")]);
}

async function healthPoll(checkout: string, attempts = 30): Promise<boolean> {
  const port = process.env.EVE_RUNTIME_URL || "http://127.0.0.1:3000";
  const url = `${port.replace(/\/+$/, "")}/eve/v1/health`;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export async function setup(cfg: EiConfig, flags: Record<string, string | boolean>): Promise<number> {
  const plan = planSetup(cfg);
  if (flags["dry-run"]) {
    process.stdout.write(card("ei setup — dry run", plan.map((s) => ({ key: s.label, value: s.action, color: theme.dim }))));
    process.stdout.write(theme.dim(`checkout: ${cfg.checkoutPath} · unit: ${cfg.unitName} · doppler: ${cfg.dopplerProject}/${cfg.dopplerConfig}\n`));
    return 0;
  }
  if (flags.json) {
    // setup is interactive; json is not supported
    process.stderr.write(errorCard("setup", ["--json is not supported for the interactive setup flow."]));
    return 2;
  }
  const missing = ["bun", "git", "doppler"].filter((b) => !requireBin(b));
  if (missing.length) {
    process.stderr.write(errorCard("setup", [`Missing: ${missing.join(", ")}`, "Install them, then re-run ei setup."]));
    return 3;
  }
  for (const step of plan) {
    switch (step.action) {
      case "preflight":
        plugStep(step.label, true, `${cfg.checkoutPath}`);
        break;
      case "doppler-project": {
        await runStep(step.label, async () => {
          const authed = await run(["doppler", "whoami"]);
          if (!authed.ok) {
            const code = await runInteractive(["doppler", "login"]);
            if (code !== 0) throw new Error("doppler login failed — re-run ei setup after authenticating");
          }
          const project = await run(["doppler", "projects", "get", "--project", cfg.dopplerProject]);
          if (!project.ok) {
            const created = await run(["doppler", "projects", "create", cfg.dopplerProject]);
            if (!created.ok) throw new Error(`doppler projects create failed (${created.code})\n${created.stderr.slice(-1000)}`);
          }
          const conf = await run(["doppler", "configs", "get", cfg.dopplerConfig, "--project", cfg.dopplerProject]);
          if (!conf.ok) {
            const created = await run(["doppler", "configs", "create", cfg.dopplerConfig, "--project", cfg.dopplerProject]);
            if (!created.ok) throw new Error(`doppler configs create failed (${created.code})\n${created.stderr.slice(-1000)}`);
          }
        });
        break;
      }
      case "env-sync": {
        let summary = { set: [] as string[], skipped: [] as string[] };
        await runStep(step.label, async () => {
          summary = await syncEnv(cfg, defaultEnvSyncDeps(cfg));
        });
        process.stdout.write(theme.dim(`  set: ${summary.set.join(", ")} · skipped: ${summary.skipped.join(", ") || "—"}\n`));
        break;
      }
      case "install":
        await runStep(step.label, async () => {
          const r = await run(["bun", "install", "--frozen-lockfile"], { cwd: cfg.checkoutPath });
          if (!r.ok) throw new Error(`bun install failed (${r.code})\n${r.stderr.slice(-2000)}`);
        });
        break;
      case "postgres-schema":
        await runStep(step.label, async () => {
          const r = await run(
            ["doppler", "run", "--project", cfg.dopplerProject, "--config", cfg.dopplerConfig, "--", "bunx", "--package", "@workflow/world-postgres", "bootstrap"],
            { cwd: path.join(cfg.checkoutPath, "packages/agent") },
          );
          if (!r.ok) throw new Error(`postgres schema failed (${r.code})\n${r.stderr.slice(-2000)}`);
        });
        break;
      case "typecheck":
        await runStep(step.label, async () => {
          const r = await run(["bun", "run", "typecheck"], { cwd: cfg.checkoutPath });
          if (!r.ok) throw new Error(`typecheck failed (${r.code})\n${r.stderr.slice(-2000)}`);
        });
        break;
      case "build":
        await runStep(step.label, async () => {
          const r = await run(["doppler", "run", "--project", cfg.dopplerProject, "--config", cfg.dopplerConfig, "--", "bunx", "eve", "build"], { cwd: path.join(cfg.checkoutPath, "packages/agent") });
          if (!r.ok) throw new Error(`eve build failed (${r.code})\n${r.stderr.slice(-2000)}`);
        });
        break;
      case "register":
        await runStep(step.label, async () => {
          const r = await run(["doppler", "run", "--project", cfg.dopplerProject, "--config", cfg.dopplerConfig, "--", "bun", "scripts/register-commands.ts"], { cwd: cfg.checkoutPath });
          if (!r.ok) throw new Error(`register-commands failed (${r.code})\n${r.stderr.slice(-2000)}`);
        });
        break;
      case "write-config":
        writeConfig(cfg);
        plugStep(step.label, true, JSON.stringify(cfg));
        break;
      case "systemd": {
        const hasSystemd = Boolean(requireBin("systemctl"));
        if (!hasSystemd) {
          const bunBinDir = await resolveBunBinDir();
          await ensureNodeAlias(bunBinDir);
          plugStep(step.label, true, `run manually: doppler run --project ${cfg.dopplerProject} --config ${cfg.dopplerConfig} -- ${bunBinDir}/bun x eve start`);
          break;
        }
        const user = (await run(["whoami"])).stdout.trim();
        const bunBinDir = await resolveBunBinDir();
        await ensureNodeAlias(bunBinDir);
        const shouldInstall = await confirm(`Install/refresh systemd unit ${cfg.unitName} for user ${user}?`);
        if (shouldInstall === false) {
          plugStep(step.label, true, "skipped");
          break;
        }
        await runStep(step.label, async () => {
          const unit = unitFile(cfg, user, bunBinDir);
          const tmp = path.join(cfg.checkoutPath, `.ei.${cfg.unitName}.service`);
          await Bun.write(tmp, unit);
          const write = await run(["sudo", "install", "-o", "root", "-g", "root", "-m", "644", tmp, `/etc/systemd/system/${cfg.unitName}.service`]);
          await Bun.$`rm -f ${tmp}`.nothrow();
          if (!write.ok) throw new Error(`writing unit failed (${write.code})\n${write.stderr.slice(-2000)}`);
          for (const c of [["sudo", "systemctl", "daemon-reload"], ["sudo", "systemctl", "enable", cfg.unitName]]) {
            const r = await run(c);
            if (!r.ok) throw new Error(`${c.join(" ")} failed (${r.code})\n${r.stderr.slice(-2000)}`);
          }
        });
        break;
      }
      case "start": {
        await runStep(step.label, async () => {
          const idRes = await run(["id", "-u"]);
          const isRoot = idRes.ok && idRes.stdout.trim() === "0";
          await run(["systemctl", "start", cfg.unitName], { sudo: !isRoot });
          if (!(await healthPoll(cfg.checkoutPath))) {
            const logRes = await run(["journalctl", "-u", cfg.unitName, "-n", "50"]);
            throw new Error(`health poll timed out\n${logRes.stdout}${logRes.stderr}`);
          }
        });
        break;
      }
    }
  }
  process.stdout.write(theme.ok(`\n✔ ei setup complete. Talk to the agent in Discord, or run ei status.\n`));
  return 0;
}
