// lib/jscpd.ts
// Duplication detection via jscpd v5 (a native binary distributed as npm
// platform packages, e.g. jscpd-linux-x64-gnu). The agent tool spawns the
// binary and parses its JSON report — no network at runtime.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/** Map a platform/arch pair to jscpd's native package name, or null if unsupported. */
export function jscpdPlatformPackage(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "linux" && arch === "x64") return "jscpd-linux-x64-gnu";
  if (platform === "linux" && arch === "arm64") return "jscpd-linux-arm64-gnu";
  if (platform === "darwin" && arch === "arm64") return "jscpd-darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "jscpd-darwin-x64";
  if (platform === "win32" && arch === "x64") return "jscpd-windows-x64-msvc";
  return null;
}

/** Resolve the jscpd binary: JSCPD_PATH, the installed platform package, then PATH. Never downloads. */
export function resolveJscpdBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.JSCPD_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const pkg = jscpdPlatformPackage();
  if (pkg) {
    try {
      const req = createRequire(import.meta.url);
      // Resolve the platform package relative to jscpd itself: bun's isolated
      // linker nests it under jscpd's install, not under the consumer.
      const jscpdDir = path.dirname(req.resolve("jscpd/package.json"));
      const pj = req.resolve(`${pkg}/package.json`, { paths: [jscpdDir, path.dirname(jscpdDir)] });
      const bin = path.join(path.dirname(pj), "bin", process.platform === "win32" ? "jscpd.exe" : "jscpd");
      if (existsSync(bin)) return bin;
    } catch {
      // platform package not installed; fall through to PATH
    }
  }
  const which = spawnSync("which", ["jscpd"], { encoding: "utf8" });
  const found = which.stdout?.trim();
  return found || null;
}

export interface JscpdFileLoc {
  name: string;
  start: number;
  end: number;
}

export interface JscpdClone {
  format: string;
  lines: number;
  tokens: number;
  firstFile: JscpdFileLoc;
  secondFile: JscpdFileLoc;
}

export interface JscpdSummary {
  clones: number;
  duplicatedLines: number;
  lines: number;
  percentage: number;
  sources: number;
}

export interface JscpdResult {
  summary: JscpdSummary;
  clones: JscpdClone[];
}

function rel(name: string, root?: string): string {
  if (!root) return name;
  const r = root.replace(/\/+$/, "");
  return name.startsWith(r + "/") ? name.slice(r.length + 1) : name;
}

/** Parse a jscpd JSON report into a summary plus clone locations (largest first). */
export function parseJscpdReport(raw: unknown, root?: string): JscpdResult {
  const report = (raw ?? {}) as {
    statistics?: { total?: Record<string, number> };
    duplicates?: Array<{
      format?: string;
      lines?: number;
      tokens?: number;
      firstFile?: { name?: string; start?: number; end?: number };
      secondFile?: { name?: string; start?: number; end?: number };
    }>;
  };
  const total = report.statistics?.total ?? {};
  const summary: JscpdSummary = {
    clones: total.clones ?? 0,
    duplicatedLines: total.duplicatedLines ?? 0,
    lines: total.lines ?? 0,
    percentage: total.percentage ?? 0,
    sources: total.sources ?? 0,
  };
  const clones: JscpdClone[] = (report.duplicates ?? [])
    .filter((d) => d.firstFile?.name && d.secondFile?.name)
    .map((d) => ({
      format: d.format ?? "unknown",
      lines: d.lines ?? 0,
      tokens: d.tokens ?? 0,
      firstFile: { name: rel(d.firstFile!.name!, root), start: d.firstFile!.start ?? 0, end: d.firstFile!.end ?? 0 },
      secondFile: { name: rel(d.secondFile!.name!, root), start: d.secondFile!.start ?? 0, end: d.secondFile!.end ?? 0 },
    }))
    .sort((a, b) => b.lines - a.lines);
  return { summary, clones };
}

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/.output/**",
  "**/.eve/**",
  "**/target/**",
  "**/.next/**",
  "**/*.md",
  "**/bun.lock",
  "**/*.lockb",
];

function spawnAsync(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Run jscpd over a directory and return the parsed report. */
export async function runJscpd(opts: {
  path: string;
  limit?: number;
  minLines?: number;
  bin?: string;
  ignore?: string[];
}): Promise<JscpdResult> {
  const bin = opts.bin ?? resolveJscpdBin();
  if (!bin) {
    throw new Error("jscpd binary not found. Run `bun install` in the agent package, or set JSCPD_PATH.");
  }
  const out = await mkdtemp(path.join(os.tmpdir(), "ei-jscpd-"));
  try {
    const args = [
      opts.path,
      "--reporters",
      "json",
      "--output",
      out,
      "--absolute",
      "--silent",
      "--ignore",
      (opts.ignore ?? DEFAULT_IGNORE).join(","),
    ];
    if (opts.minLines !== undefined) args.push("--min-lines", String(opts.minLines));
    let r: { code: number; stdout: string; stderr: string };
    try {
      r = await spawnAsync(bin, args);
    } catch (err) {
      throw new Error(`jscpd failed to start (${(err as Error).message}). Check the binary at ${bin}.`);
    }
    if (r.code !== 0) {
      throw new Error(`jscpd failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-1000)}`);
    }
    const raw = JSON.parse(await readFile(path.join(out, "jscpd-report.json"), "utf8"));
    const result = parseJscpdReport(raw, opts.path);
    if (opts.limit !== undefined) result.clones = result.clones.slice(0, opts.limit);
    return result;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
