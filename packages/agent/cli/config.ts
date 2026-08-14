// cli/config.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface EiConfig {
  checkoutPath: string;
  unitName: string;
  dopplerProject: string;
  dopplerConfig: string;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "ei", "config.json");
}

export function findCheckout(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function readConfig(flags: {
  checkout?: string;
  unit?: string;
  project?: string;
  config?: string;
}): Promise<EiConfig> {
  const file: Partial<EiConfig> = {};
  const p = configPath();
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<EiConfig>;
      Object.assign(file, parsed);
    } catch {
      // corrupt config: fall through to defaults; setup will rewrite it
    }
  }
  const checkout = flags.checkout ?? file.checkoutPath ?? findCheckout() ?? path.join(homedir(), "ei");
  return {
    checkoutPath: checkout,
    unitName: flags.unit ?? file.unitName ?? "ei",
    dopplerProject: flags.project ?? file.dopplerProject ?? "ei",
    dopplerConfig: flags.config ?? file.dopplerConfig ?? "prd",
  };
}

export function writeConfig(cfg: EiConfig): void {
  const p = configPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}
