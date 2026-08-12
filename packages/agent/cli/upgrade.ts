// cli/upgrade.ts
import { existsSync, renameSync, copyFileSync, chmodSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { EiConfig } from "./config";
import { run } from "./run";
import { currentVersion, compareSemver, platformTarget, latestRelease, releaseAssetName } from "./version";
import { runStep, plugStep } from "./ui/step";
import { errorCard } from "./ui/card";
import { theme } from "./ui/theme";

export interface UpgradeDecision {
  selfUpdate: boolean;
  agentUpdate: boolean;
  reason: string;
}

export function decideUpgrade(me: string, latestTag: string, checkoutTag: string): UpgradeDecision {
  const selfUpdate = me !== "dev" && compareSemver(latestTag, me) > 0;
  const agentUpdate = checkoutTag !== latestTag;
  const reason = `${me} -> ${latestTag} (checkout at ${checkoutTag || "no tag"})`;
  return { selfUpdate, agentUpdate, reason };
}

export function planUpgrade(cfg: EiConfig, d: UpgradeDecision, exe: string, tag: string): string[] {
  const steps: string[] = [];
  const target = platformTarget();
  if (d.selfUpdate) steps.push(`download ${releaseAssetName(target)} -> ${exe} (${tag})`);
  if (d.agentUpdate) {
    steps.push(
      `git fetch origin (cwd ${cfg.checkoutPath})`,
      `git fetch --tags origin`,
      `git checkout ${tag}`,
      `bun install --frozen-lockfile`,
      `bun run typecheck`,
      `doppler run --project ${cfg.dopplerProject} -- bunx eve build`,
      `doppler run --project ${cfg.dopplerProject} -- bun scripts/register-commands.ts`,
      `systemctl restart ${cfg.unitName}`,
      `poll /eve/v1/health`,
    );
  }
  if (!steps.length) steps.push("already at latest");
  return steps;
}

export async function selfUpdate(tag: string, exe: string): Promise<void> {
  const target = platformTarget();
  const rel = await latestRelease();
  const url = rel.assets[releaseAssetName(target)];
  if (!url) throw new Error(`no ${releaseAssetName(target)} asset in release ${rel.tag}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 100_000) throw new Error("downloaded file looks too small");
  const tmp = `${exe}.${tag}.new`;
  const bak = `${exe}.bak`;
  await Bun.write(tmp, bytes);
  chmodSync(tmp, 0o755);
  if (existsSync(bak)) unlinkSync(bak);
  copyFileSync(exe, bak);
  renameSync(tmp, exe);
  await run([exe, "version"]);
  plugStep("self-update", true, `${exe} -> ${tag}`);
}

export async function upgrade(cfg: EiConfig, flags: Record<string, string | boolean>): Promise<number> {
  const exe = process.execPath;
  let rel;
  try {
    rel = await latestRelease();
  } catch (err) {
    process.stderr.write(errorCard("upgrade", [`cannot reach GitHub releases: ${err instanceof Error ? err.message : String(err)}`]));
    return 1;
  }
  const checkoutTag = (await run(["git", "describe", "--tags", "--exact-match", "HEAD"], { cwd: cfg.checkoutPath })).stdout.trim();
  const decision = decideUpgrade(currentVersion(), rel.tag, checkoutTag);
  if (flags["dry-run"]) {
    process.stdout.write(theme.strong("ei upgrade — dry run") + theme.dim(` (${decision.reason})`) + "\n");
    for (const step of planUpgrade(cfg, decision, exe, rel.tag)) process.stdout.write(`  · ${step}\n`);
    process.stdout.write(theme.dim(`latest: ${rel.tag} · ${exe}\n`));
    return 0;
  }
  if (decision.selfUpdate) {
    await runStep("self-update", async () => {
      await selfUpdate(rel.tag, exe);
    });
    // hand off to the new binary for phase 2 (self-update only runs on stamped builds)
    const child = spawn(exe, process.argv.slice(1), { stdio: "inherit" });
    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    return 0;
  }
  if (!decision.agentUpdate) {
    process.stdout.write(theme.ok("Already up to date") + theme.dim(` (${rel.tag})\n`));
    return 0;
  }
  await runStep("git fetch + checkout", async () => {
    for (const c of [
      ["git", "fetch", "origin"],
      ["git", "fetch", "--tags", "origin"],
      ["git", "checkout", rel.tag],
    ]) {
      const r = await run(c, { cwd: cfg.checkoutPath });
      if (!r.ok) throw new Error(`${c.join(" ")} failed (${r.code})\n${r.stderr.slice(-2000)}`);
    }
  });
  await runStep("bun install", async () => {
    const r = await run(["bun", "install", "--frozen-lockfile"], { cwd: cfg.checkoutPath });
    if (!r.ok) throw new Error(`bun install failed (${r.code})\n${r.stderr.slice(-2000)}`);
  });
  await runStep("typecheck", async () => {
    const r = await run(["bun", "run", "typecheck"], { cwd: cfg.checkoutPath });
    if (!r.ok) throw new Error(`typecheck failed (${r.code})\n${r.stderr.slice(-2000)}`);
  });
  await runStep("build", async () => {
    const r = await run(["doppler", "run", "--project", cfg.dopplerProject, "--", "bunx", "eve", "build"], { cwd: path.join(cfg.checkoutPath, "packages/agent") });
    if (!r.ok) throw new Error(`eve build failed (${r.code})\n${r.stderr.slice(-2000)}`);
  });
  await runStep("register-commands", async () => {
    const r = await run(["doppler", "run", "--project", cfg.dopplerProject, "--", "bun", "scripts/register-commands.ts"], { cwd: cfg.checkoutPath });
    if (!r.ok) throw new Error(`register-commands failed (${r.code})\n${r.stderr.slice(-2000)}`);
  });
  await runStep("restart unit", async () => {
    const idRes = await run(["id", "-u"]);
    const isRoot = idRes.ok && idRes.stdout.trim() === "0";
    const r = await run(["systemctl", "restart", cfg.unitName], { sudo: !isRoot });
    if (!r.ok) throw new Error(`systemctl restart ${cfg.unitName} failed (${r.code})\n${r.stderr.slice(-2000)}`);
  });
  await runStep("health poll", async () => {
    const url = `${(process.env.EVE_RUNTIME_URL || "http://127.0.0.1:3000").replace(/\/+$/, "")}/eve/v1/health`;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        // keep polling
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const logs = await run(["journalctl", "-u", cfg.unitName, "-n", "50"]);
    throw new Error(`health poll timed out\n${logs.stdout}${logs.stderr}`);
  });
  process.stdout.write(theme.ok(`\n✔ ei upgraded to ${rel.tag}\n`));
  return 0;
}
