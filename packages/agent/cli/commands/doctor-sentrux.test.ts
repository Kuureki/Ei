// cli/commands/doctor-sentrux.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkSentrux } from "./doctor";

async function fakeBin(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ei-doctor-"));
  const bin = path.join(dir, name);
  await writeFile(bin, body, { mode: 0o755 });
  return bin;
}

describe("checkSentrux", () => {
  test("ok when the binary resolves and --version works", async () => {
    const bin = await fakeBin("sentrux", "#!/bin/sh\necho sentrux 0.5.7\n");
    await chmod(bin, 0o755);
    const check = await checkSentrux({
      bin,
      run: async () => ({ ok: true, code: 0, stdout: "sentrux 0.5.7\n", stderr: "" }),
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("sentrux");
    await rm(path.dirname(bin), { recursive: true, force: true });
  });
  test("not ok when the binary is absent", async () => {
    const check = await checkSentrux({ bin: null });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("ei setup");
  });
  test("not ok when --version fails", async () => {
    const bin = await fakeBin("sentrux-broken", "#!/bin/sh\nexit 3\n");
    const check = await checkSentrux({
      bin,
      run: async () => ({ ok: false, code: 3, stdout: "", stderr: "boom" }),
    });
    expect(check.ok).toBe(false);
    await rm(path.dirname(bin), { recursive: true, force: true });
  });
});
