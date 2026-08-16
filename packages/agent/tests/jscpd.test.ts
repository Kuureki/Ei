// tests/jscpd.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jscpdPlatformPackage, parseJscpdReport, resolveJscpdBin, runJscpd } from "../lib/jscpd";

describe("jscpdPlatformPackage", () => {
  test("maps supported platforms to package names", () => {
    expect(jscpdPlatformPackage("linux", "x64")).toBe("jscpd-linux-x64-gnu");
    expect(jscpdPlatformPackage("linux", "arm64")).toBe("jscpd-linux-arm64-gnu");
    expect(jscpdPlatformPackage("darwin", "arm64")).toBe("jscpd-darwin-arm64");
    expect(jscpdPlatformPackage("darwin", "x64")).toBe("jscpd-darwin-x64");
    expect(jscpdPlatformPackage("win32", "x64")).toBe("jscpd-windows-x64-msvc");
  });
  test("returns null for unsupported platforms", () => {
    expect(jscpdPlatformPackage("linux", "ia32")).toBeNull();
    expect(jscpdPlatformPackage("freebsd", "x64")).toBeNull();
  });
});

describe("resolveJscpdBin", () => {
  test("honors JSCPD_PATH when the file exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ei-jscpd-test-"));
    const bin = path.join(dir, "custom-jscpd");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(resolveJscpdBin({ JSCPD_PATH: bin })).toBe(bin);
    await rm(dir, { recursive: true, force: true });
  });
  test("ignores JSCPD_PATH when the file is missing", () => {
    expect(resolveJscpdBin({ JSCPD_PATH: "/nonexistent/jscpd" })).not.toBe("/nonexistent/jscpd");
  });
  test("finds the installed platform package binary", () => {
    // jscpd is a dependency of this package, so the platform binary resolves
    expect(resolveJscpdBin({})).not.toBeNull();
  });
});

describe("parseJscpdReport", () => {
  const report = {
    statistics: {
      total: { clones: 2, duplicatedLines: 20, lines: 100, percentage: 20, sources: 4, tokens: 500, duplicatedTokens: 100 },
    },
    duplicates: [
      {
        format: "typescript",
        lines: 5,
        tokens: 40,
        firstFile: { name: "/repo/src/a.ts", start: 1, end: 5, startLoc: {}, endLoc: {} },
        secondFile: { name: "/repo/src/b.ts", start: 10, end: 14, startLoc: {}, endLoc: {} },
      },
      {
        format: "typescript",
        lines: 15,
        tokens: 60,
        firstFile: { name: "/repo/src/c.ts", start: 2, end: 16 },
        secondFile: { name: "/repo/src/d.ts", start: 3, end: 17 },
      },
    ],
  };

  test("summarizes totals", () => {
    const r = parseJscpdReport(report, "/repo");
    expect(r.summary).toEqual({ clones: 2, duplicatedLines: 20, lines: 100, percentage: 20, sources: 4 });
  });
  test("sorts clones largest first and relativizes paths", () => {
    const r = parseJscpdReport(report, "/repo");
    expect(r.clones.map((c) => c.lines)).toEqual([15, 5]);
    expect(r.clones[1].firstFile).toEqual({ name: "src/a.ts", start: 1, end: 5 });
    expect(r.clones[1].secondFile).toEqual({ name: "src/b.ts", start: 10, end: 14 });
  });
  test("tolerates empty or malformed reports", () => {
    expect(parseJscpdReport({}).summary.clones).toBe(0);
    expect(parseJscpdReport(null).clones).toEqual([]);
    expect(parseJscpdReport({ duplicates: [{ lines: 3 }] }).clones).toEqual([]);
  });
});

describe("runJscpd", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  test("finds a known duplicate in a scratch directory", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ei-jscpd-scan-"));
    const block = Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i} * 2;`).join("\n");
    await writeFile(path.join(dir, "one.ts"), `// one\n${block}\n`);
    await writeFile(path.join(dir, "two.ts"), `// two\n${block}\n`);
    const r = await runJscpd({ path: dir });
    expect(r.summary.clones).toBeGreaterThanOrEqual(1);
    // token-based clone boundaries may trim a line or two off the raw block
    expect(r.summary.duplicatedLines).toBeGreaterThanOrEqual(10);
    expect(r.clones[0].firstFile.name).toBe("one.ts");
    expect(r.clones[0].secondFile.name).toBe("two.ts");
  });

  test("reports zero duplicates on a clean directory", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ei-jscpd-clean-"));
    await writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(dir, "b.ts"), "export const b = 2;\n");
    const r = await runJscpd({ path: dir });
    expect(r.summary.clones).toBe(0);
    expect(r.clones).toEqual([]);
  });

  test("respects the limit option", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ei-jscpd-limit-"));
    const block = Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i} * 2;`).join("\n");
    await writeFile(path.join(dir, "one.ts"), block);
    await writeFile(path.join(dir, "two.ts"), block);
    await writeFile(path.join(dir, "three.ts"), block);
    const r = await runJscpd({ path: dir, limit: 1 });
    expect(r.clones.length).toBeLessThanOrEqual(1);
    expect(r.summary.clones).toBeGreaterThanOrEqual(2);
  });

  test("fails clearly when the binary is missing", async () => {
    await expect(runJscpd({ path: "/tmp", bin: "/nonexistent/jscpd" })).rejects.toThrow(/jscpd failed/);
  });
});
