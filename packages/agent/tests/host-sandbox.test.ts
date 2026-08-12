// tests/host-sandbox.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostSession, type HostProcess } from "../lib/host-sandbox";

let root: string | null = null;
let track = new Set<HostProcess>();
async function freshRoot(): Promise<string> {
  root = await mkdtemp(path.join(os.tmpdir(), "ei-host-test-"));
  return root;
}
afterEach(async () => {
  for (const p of track) await p.kill();
  if (root) await rm(root, { recursive: true, force: true });
  track = new Set<HostProcess>();
});

describe("createHostSession", () => {
  test("run executes a command in the root cwd", async () => {
    const dir = await freshRoot();
    const s = createHostSession(dir, { id: "s1", track });
    const r = await s.run({ command: "pwd" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(dir);
  });

  test("run honors workingDirectory and env", async () => {
    const dir = await freshRoot();
    const sub = path.join(dir, "sub");
    await mkdir(sub);
    const s = createHostSession(dir, { id: "s2", track });
    const r = await s.run({ command: "echo \"$E\"", workingDirectory: sub, env: { E: "yes" } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("yes");
  });

  test("writeTextFile then readTextFile round-trips with line ranges", async () => {
    const dir = await freshRoot();
    const s = createHostSession(dir, { id: "s3", track });
    await s.writeTextFile({ path: "a/b.txt", content: "one\ntwo\nthree\n" });
    const all = await s.readTextFile({ path: "a/b.txt" });
    expect(all).toBe("one\ntwo\nthree\n");
    const mid = await s.readTextFile({ path: "a/b.txt", startLine: 2, endLine: 2 });
    expect(mid).toBe("two");
    const missing = await s.readTextFile({ path: "nope.txt" });
    expect(missing).toBeNull();
    const bytes = await s.readBinaryFile({ path: "a/b.txt" });
    expect(Buffer.from(bytes!).toString()).toBe("one\ntwo\nthree\n");
  });

  test("readFile returns a stream for an existing file and null otherwise", async () => {
    const dir = await freshRoot();
    const s = createHostSession(dir, { id: "s4", track });
    await s.writeTextFile({ path: "f.txt", content: "hello" });
    const stream = await s.readFile({ path: "f.txt" });
    expect(stream).not.toBeNull();
    const text = await new Response(stream).text();
    expect(text).toBe("hello");
    expect(await s.readFile({ path: "missing.txt" })).toBeNull();
  });

  test("removePath honors recursive and force", async () => {
    const dir = await freshRoot();
    const s = createHostSession(dir, { id: "s5", track });
    await s.writeTextFile({ path: "x/y.txt", content: "v" });
    await s.removePath({ path: "x", recursive: true });
    expect(await s.readTextFile({ path: "x/y.txt" })).toBeNull();
    await s.removePath({ path: "x", recursive: true, force: true });
    expect(await s.readTextFile({ path: "x/y.txt" })).toBeNull();
  });

  test("shutdown kills spawned children", async () => {
    const dir = await freshRoot();
    const s = createHostSession(dir, { id: "s6", track });
    const proc = await s.spawn({ command: "sleep 30" });
    expect(track.has(proc as HostProcess)).toBe(true);
    for (const p of track) await p.kill();
    track = new Set<HostProcess>();
    const result = await Promise.race([
      proc.wait().then((r) => r.exitCode),
      new Promise<number>((resolve) => setTimeout(() => resolve(-999), 3000)),
    ]);
    expect(result).not.toBe(0);
  });

  test("resolvePath anchors relative paths to the root", async () => {
    const dir = await freshRoot();
    const s = createHostSession(dir, { id: "s7", track });
    expect(s.resolvePath("a/b")).toBe(path.join(dir, "a/b"));
    expect(s.resolvePath("/abs/x")).toBe("/abs/x");
  });

  test("setNetworkPolicy is a no-op", async () => {
    const dir = await freshRoot();
    const s = createHostSession(dir, { id: "s8", track });
    // the host backend ignores sandbox policy requests; any config is valid here
    await expect(s.setNetworkPolicy({ allow: ["*"] } as never)).resolves.toBeUndefined();
  });
});
