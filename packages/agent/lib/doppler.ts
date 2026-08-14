// Doppler plumbing for in-process `doppler secrets set` calls.
// The agent never relies on a `doppler setup` scope file: every invocation
// passes explicit --project/--config, resolved from the environment with
// sensible defaults for Ei.
import { spawn } from "node:child_process";

export function dopplerScope(env: Record<string, string | undefined>): { project: string; config: string } {
  return {
    project: env.DOPPLER_PROJECT ?? "ei",
    config: env.DOPPLER_CONFIG ?? "prd",
  };
}

export function setSecretInDoppler(env: Record<string, string | undefined>): (key: string, value: string) => Promise<void> {
  const { project, config } = dopplerScope(env);
  return (key, value) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("doppler", ["secrets", "set", "--project", project, "--config", config, `${key}=${value}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
      child.on("error", (err) => reject(new Error(`doppler binary unavailable: ${err.message}`)));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`doppler secrets set failed (${code}): ${stderr.slice(-300)}`));
      });
    });
}
