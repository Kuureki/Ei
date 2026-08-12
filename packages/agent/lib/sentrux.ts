// lib/sentrux.ts
import { chmod, existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SENTRUX_URL = "https://github.com/sentrux/sentrux/releases/latest/download";

/** Map a node process.arch to sentrux's linux release asset, or null. */
export function sentruxAssetName(arch: string): string | null {
  if (arch === "x64") return "sentrux-linux-x86_64";
  if (arch === "arm64") return "sentrux-linux-aarch64";
  return null;
}

const DEFAULT_BIN = "/usr/local/bin/sentrux";

/** Resolve an existing sentrux binary: SENTRUX_PATH, then the default path. Never downloads. */
export function resolveSentruxBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.SENTRUX_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  return existsSync(DEFAULT_BIN) ? DEFAULT_BIN : null;
}

/** Ensure a sentrux binary exists, downloading it if needed. Returns the binary path. */
export async function ensureSentrux(opts: {
  fetchImpl?: typeof fetch;
  binPath?: string;
  arch?: string;
} = {}): Promise<string> {
  const binPath = opts.binPath ?? resolveSentruxBin() ?? DEFAULT_BIN;
  if (existsSync(binPath)) return binPath;

  const asset = sentruxAssetName(opts.arch ?? process.arch);
  if (!asset) {
    throw new Error(`unsupported arch '${opts.arch ?? process.arch}' for sentrux (linux x64/arm64 only)`);
  }
  const url = `${SENTRUX_URL}/${asset}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `sentrux download failed (HTTP ${res.status}). Install manually: ` +
        `curl -fsSL https://raw.githubusercontent.com/sentrux/sentrux/main/install.sh | sh`,
    );
  }
  const body = Buffer.from(await res.arrayBuffer());
  const dir = path.dirname(binPath);
  await mkdir(dir, { recursive: true });
  const tmp = `${binPath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, body, { mode: 0o755 });
  await rename(tmp, binPath);
  chmod(binPath, 0o755, () => {});
  return binPath;
}
