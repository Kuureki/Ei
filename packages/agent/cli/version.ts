// cli/version.ts
import { EI_VERSION } from "./build/version";

export function currentVersion(): string {
  return typeof EI_VERSION === "string" && EI_VERSION.length > 0 ? EI_VERSION : "dev";
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(v: string): Semver {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return { major: 0, minor: 0, patch: 0 };
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return 0;
}

export type PlatformTarget = "bun-linux-x64" | "bun-linux-arm64";

export function platformTarget(): PlatformTarget {
  if (process.platform === "linux" && process.arch === "x64") return "bun-linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "bun-linux-arm64";
  return "bun-linux-x64";
}

export function releaseAssetName(target: PlatformTarget): string {
  return `ei-${target.replace("bun-", "")}`;
}

export interface ReleaseInfo {
  tag: string;
  assets: Record<string, string>;
}

type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export async function latestRelease(opts: { fetchImpl?: FetchLike } = {}): Promise<ReleaseInfo> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f("https://api.github.com/repos/Kuureki/Ei/releases/latest", {
    headers: { accept: "application/vnd.github+json", "user-agent": "ei-cli" },
  });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const json = (await res.json()) as {
    tag_name?: unknown;
    assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
  };
  const tag = typeof json.tag_name === "string" ? json.tag_name : "v0.0.0";
  const assets: Record<string, string> = {};
  for (const a of json.assets ?? []) {
    if (typeof a.name === "string" && typeof a.browser_download_url === "string") {
      assets[a.name] = a.browser_download_url;
    }
  }
  return { tag, assets };
}

export function releaseUrl(tag: string): string {
  return `https://github.com/Kuureki/Ei/releases/tag/${tag}`;
}
