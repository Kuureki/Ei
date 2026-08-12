// tests/sentrux-install.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureSentrux, resolveSentruxBin, sentruxAssetName } from "../lib/sentrux";

let tmp: string | null = null;
async function freshDir(): Promise<string> {
  tmp = await mkdtemp(path.join(os.tmpdir(), "ei-sentrux-test-"));
  return tmp;
}
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("sentruxAssetName", () => {
  test("maps arches to release assets", () => {
    expect(sentruxAssetName("x64")).toBe("sentrux-linux-x86_64");
    expect(sentruxAssetName("arm64")).toBe("sentrux-linux-aarch64");
    expect(sentruxAssetName("ia32")).toBeNull();
  });
});

describe("resolveSentruxBin", () => {
  test("honors SENTRUX_PATH when the file exists", async () => {
    const dir = await freshDir();
    const bin = path.join(dir, "custom-sentrux");
    await writeFile(bin, "#!/bin/sh\necho x\n", { mode: 0o755 });
    expect(resolveSentruxBin({ SENTRUX_PATH: bin })).toBe(bin);
  });
  test("ignores SENTRUX_PATH when the file is missing", async () => {
    const dir = await freshDir();
    const bin = path.join(dir, "nope");
    expect(resolveSentruxBin({ SENTRUX_PATH: bin })).toBeNull();
  });
  test("falls back to /usr/local/bin/sentrux", () => {
    const exists = resolveSentruxBin({});
    expect(exists === null || exists === "/usr/local/bin/sentrux").toBe(true);
  });
});

describe("ensureSentrux", () => {
  test("returns an existing bin without downloading", async () => {
    const dir = await freshDir();
    const bin = path.join(dir, "sentrux");
    await writeFile(bin, "#!/bin/sh\necho x\n", { mode: 0o755 });
    let calls = 0;
    const p = await ensureSentrux({
      binPath: bin,
      fetchImpl: (async () => {
        calls++;
        throw new Error("must not download");
      }) as unknown as typeof fetch,
    });
    expect(p).toBe(bin);
    expect(calls).toBe(0);
  });

  test("downloads the right asset for the arch and makes it executable", async () => {
    const dir = await freshDir();
    const target = path.join(dir, "sentrux");
    let fetched: string | null = null;
    const p = await ensureSentrux({
      binPath: target,
      arch: "arm64",
      fetchImpl: (async (url: URL | string) => {
        fetched = String(url);
        return new Response("#!/bin/sh\necho fake\n");
      }) as unknown as typeof fetch,
    });
    expect(p).toBe(target);
    expect(fetched ?? "").toContain("/releases/latest/download/sentrux-linux-aarch64");
    expect(await stat(target)).toBeDefined();
    const mode = (await stat(target)).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  test("fails clearly on unsupported arch", async () => {
    const dir = await freshDir();
    await expect(
      ensureSentrux({ binPath: path.join(dir, "s"), arch: "ia32", fetchImpl: (async () => new Response("")) as unknown as typeof fetch }),
    ).rejects.toThrow(/unsupported arch/);
  });

  test("fails clearly when the download does not return ok", async () => {
    const dir = await freshDir();
    await expect(
      ensureSentrux({ binPath: path.join(dir, "s"), arch: "x64", fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch }),
    ).rejects.toThrow(/download failed/);
  });
});
