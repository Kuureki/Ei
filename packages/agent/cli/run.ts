// cli/run.ts
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  const args = opts.sudo ? ["sudo", ...cmd] : cmd;
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
    child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: err.message });
    });
  });
}

export function runInteractive(cmd: string[], opts: RunOptions = {}): Promise<number> {
  const args = opts.sudo ? ["sudo", ...cmd] : cmd;
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code === 0 ? 0 : code ?? 1));
    child.on("error", () => resolve(1));
  });
}

export function requireBin(name: string): boolean {
  return Boolean(Bun.which(name));
}
