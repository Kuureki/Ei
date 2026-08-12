# sentrux <-> Ei MCP improve loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Ei's agent (eve) full-VPS host access and sentrux's nine MCP tools so it can run a bounded improve loop on any repo on request.

**Architecture:** (1) a custom `host` eve `SandboxBackend` makes the built-in `bash`/`read_file`/`write_file`/`glob`/`grep` tools operate on the real VPS filesystem from `EI_AGENT_ROOT` (default `/`); (2) a `sentrux` eve-tool module drives sentrux's real MCP server (`sentrux --mcp`, stdio) through `@modelcontextprotocol/sdk` in-process — no bridge, no port; (3) an instructions file defines the bounded improve loop; (4) `ei doctor`/`ei setup` gain sentrux rows/steps.

**Tech Stack:** eve 0.31 (SandboxBackend, defineSandbox, defineTool, instructions), `@modelcontextprotocol/sdk@^1.30`, node built-ins (`child_process`, `fs/promises`, `stream`), zod 4, bun test (pg-mem style, no network).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-sentrux-ei-mcp-design.md` (authoritative).
- Node 24 runtime (eve server), Bun 1.3.14 tooling; run tests with `cd packages/agent && bun test`.
- Only new runtime dependency: `@modelcontextprotocol/sdk@^1.30`. Draw everything else from node built-ins and `eve/sandbox`, `eve/tools`, `zod`.
- No new ports, no HTTP bridge, no long-running helper processes. sentrux connects via stdio, in-process.
- No network in CI tests: every network touch goes through an injectable `fetchImpl`/client factory. Live binary smoke is manual-only.
- sentrux tool names (from sentrux source registry): `scan`, `rescan`, `session_start`, `session_end`, `health`, `check_rules`, `git_stats`, `dsm`, `test_gaps`. The repo README's "evolution" is stale — the MCP name is `git_stats`.
- Naming: eve tool files map 1:1 with sentrux MCP tools (`sentruxScan` ↔ `scan`, …). Comments/sentences in the codebase are plain and lowercase-friendly per existing voice.
- Strict `tsc` (`bun run typecheck` from repo root) must stay clean; `bun test` in `packages/agent` must stay green (144 existing tests).

---

### Task 1: sentrux binary resolver + installer

**Files:**
- Create: `packages/agent/lib/sentrux.ts`
- Create: `packages/agent/tests/sentrux-install.test.ts`

**Interfaces:**
- Produces: `sentruxAssetName(arch: string): string | null`; `resolveSentruxBin(env?: NodeJS.ProcessEnv): string | null`; `ensureSentrux(opts?: { fetchImpl?: typeof fetch; binPath?: string; arch?: string }): Promise<string>`.
- Consumes: nothing. Task 3 (client) and Task 6 (CLI) use these.

- [ ] **Step 1: Write the failing test**

`packages/agent/tests/sentrux-install.test.ts`:

```ts
// tests/sentrux-install.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, stat } from "node:fs/promises";
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
      fetchImpl: (async () => { calls++; throw new Error("must not download"); }) as typeof fetch,
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
    expect(fetched).toContain("/releases/latest/download/sentrux-linux-aarch64");
    expect(await stat(target)).toBeDefined();
    const mode = (await stat(target)).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  test("fails clearly on unsupported arch", async () => {
    const dir = await freshDir();
    await expect(
      ensureSentrux({ binPath: path.join(dir, "s"), arch: "ia32", fetchImpl: (async () => new Response("")) as typeof fetch }),
    ).rejects.toThrow(/unsupported arch/);
  });

  test("fails clearly when the download does not return ok", async () => {
    const dir = await freshDir();
    await expect(
      ensureSentrux({ binPath: path.join(dir, "s"), arch: "x64", fetchImpl: (async () => new Response("nope", { status: 404 })) as typeof fetch }),
    ).rejects.toThrow(/download failed/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/agent && bun test tests/sentrux-install.test.ts`
Expected: FAIL — module not found (`Cannot find module "../lib/sentrux"` or `sentruxAssetName is not a function`).

- [ ] **Step 3: Implement `packages/agent/lib/sentrux.ts`**

```ts
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
    throw new Error(`sentrux download failed (HTTP ${res.status}). Install manually: curl -fsSL https://raw.githubusercontent.com/sentrux/sentrux/main/install.sh | sh`);
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/agent && bun test tests/sentrux-install.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/lib/sentrux.ts packages/agent/tests/sentrux-install.test.ts
git commit -m "feat(agent): sentrux binary resolver and installer"
```

---

### Task 2: host sandbox backend (unsandboxed, hermes-shaped)

**Files:**
- Create: `packages/agent/lib/host-sandbox.ts`
- Create: `packages/agent/agent/sandbox/sandbox.ts`
- Create: `packages/agent/tests/host-sandbox.test.ts`

**Interfaces:**
- Consumes: `SandboxSession` type from `eve/sandbox` (the 8 AI-SDK methods + `id`/`resolvePath`/`setNetworkPolicy`/`removePath`).
- Produces: `createHostSession(root: string, opts: { id: string; track: Set<HostProcess> }): SandboxSession`; `HostProcess` interface; `HOST_BACKEND: SandboxBackend` and default `defineSandbox({ backend: HOST_BACKEND })` from `agent/sandbox/sandbox.ts`.

- [ ] **Step 1: Write the failing test**

`packages/agent/tests/host-sandbox.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/agent && bun test tests/host-sandbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/agent/lib/host-sandbox.ts`**

```ts
// lib/host-sandbox.ts
import { spawn as nodeSpawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SandboxSession } from "eve/sandbox";

export interface HostProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

export interface HostSpawnOptions {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

/** A live sandbox session rooted at `root`, backed by the real host. */
export function createHostSession(root: string, opts: { id: string; track: Set<HostProcess> }): SandboxSession {
  const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(root, p));

  const spawn = async (o: HostSpawnOptions): Promise<HostProcess> => {
    const child = nodeSpawn(o.command, {
      cwd: o.workingDirectory ?? root,
      env: o.env ? { ...process.env, ...o.env } : process.env,
      stdio: ["inherit", "pipe", "pipe"],
      shell: true,
      ...(o.abortSignal ? { signal: o.abortSignal } : {}),
    });
    const handle: HostProcess = {
      pid: child.pid,
      stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
      wait: () =>
        new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => {
            opts.track.delete(handle);
            resolve({ exitCode: code ?? -1 });
          });
        }),
      kill: async () => child.kill("SIGKILL"),
    };
    opts.track.add(handle);
    return handle;
  };

  const collect = async (r: ReadableStream<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = [];
    const reader = r.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new TextDecoder().decode(merged);
  };

  const readBuffer = async (p: string, signal?: AbortSignal): Promise<Uint8Array | null> => {
    const fp = resolvePath(p);
    try {
      return await readFile(fp, { signal });
    } catch {
      return null;
    }
  };

  return {
    id: opts.id,
    resolvePath,
    setNetworkPolicy: async () => {},
    removePath: async (o) => { await rm(resolvePath(o.path), { force: o.force, recursive: o.recursive }); },
    spawn,
    run: async (o) => {
      const proc = await spawn(o);
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collect(proc.stdout),
        collect(proc.stderr),
        proc.wait(),
      ]);
      return { exitCode, stdout, stderr };
    },
    readFile: async (o) => {
      const fp = resolvePath(o.path);
      try { await stat(fp); } catch { return null; }
      return Readable.toWeb(createReadStream(fp)) as ReadableStream<Uint8Array>;
    },
    readBinaryFile: async (o) => await readBuffer(o.path, o.abortSignal),
    readTextFile: async (o) => {
      const data = await readBuffer(o.path, o.abortSignal);
      if (data === null) return null;
      const text = o.encoding === undefined || o.encoding === "utf-8"
        ? new TextDecoder("utf-8", { fatal: true }).decode(data)
        : Buffer.from(data).toString(o.encoding);
      if (o.startLine === undefined && o.endLine === undefined) return text;
      const lines = text.split("\n");
      const start = (o.startLine ?? 1) - 1;
      const end = o.endLine === undefined ? lines.length : o.endLine;
      return lines.slice(Math.max(0, start), end).join("\n");
    },
    writeFile: async (o) => {
      const fp = resolvePath(o.path);
      await mkdir(path.dirname(fp), { recursive: true });
      await pipeline(Readable.fromWeb(o.content as ReadableStream<Uint8Array>), createWriteStream(fp));
    },
    writeBinaryFile: async (o) => {
      const fp = resolvePath(o.path);
      await mkdir(path.dirname(fp), { recursive: true });
      await writeFile(fp, o.content);
    },
    writeTextFile: async (o) => {
      const fp = resolvePath(o.path);
      await mkdir(path.dirname(fp), { recursive: true });
      await writeFile(fp, o.content, o.encoding === undefined || o.encoding === "utf-8" ? undefined : o.encoding);
    },
  };
}
```

- [ ] **Step 4: Implement `packages/agent/agent/sandbox/sandbox.ts`**

Create the directory `packages/agent/agent/sandbox/` (the folder layout, no `workspace/` subfolder needed) with:

```ts
// agent/sandbox/sandbox.ts
import { defineSandbox, type SandboxBackend } from "eve/sandbox";
import { createHostSession, type HostProcess } from "../../lib/host-sandbox";

/**
 * Hermes-style host backend: no isolation. The built-in bash / file tools
 * operate on the real VPS filesystem from EI_AGENT_ROOT (default "/").
 */
export const HOST_BACKEND: SandboxBackend = {
  name: "host",
  async prewarm() {
    return { reused: false };
  },
  async create({ sessionKey }) {
    const root = process.env.EI_AGENT_ROOT ?? "/";
    const tracked = new Set<HostProcess>();
    const session = createHostSession(root, { id: `host-${sessionKey}`, track: tracked });
    return {
      session,
      useSessionFn: async () => session,
      captureState: async () => ({ backendName: "host", sessionKey, metadata: { root } }),
      shutdown: async () => {
        for (const p of tracked) await p.kill();
      },
    };
  },
};

export default defineSandbox({ backend: HOST_BACKEND });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/agent && bun test tests/host-sandbox.test.ts`
Expected: all pass. (The `sandbox.ts` file is exercised by `eve build`; the unit tests cover `createHostSession` directly.)

- [ ] **Step 6: Verify the file loads under the eve graph**

Run: `cd packages/agent && bun run typecheck`
Expected: clean, including `agent/sandbox/sandbox.ts` typechecking against `SandboxBackend`/`SandboxSession`.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/lib/host-sandbox.ts packages/agent/agent/sandbox/sandbox.ts packages/agent/tests/host-sandbox.test.ts
git commit -m "feat(agent): host sandbox backend for unsandboxed hermes-style access"
```

---

### Task 3: in-process MCP client for sentrux

**Files:**
- Modify: `packages/agent/package.json` (add `@modelcontextprotocol/sdk`)
- Create: `packages/agent/lib/sentrux-mcp.ts`
- Create: `packages/agent/tests/fixtures/fake-sentrux-mcp.cjs`
- Create: `packages/agent/tests/sentrux-mcp.test.ts`

**Interfaces:**
- Consumes: `ensureSentrux` / `resolveSentruxBin` from `../lib/sentrux` (Task 1), `@modelcontextprotocol/sdk` client/stdio.
- Produces: `class SentruxMcpClient { constructor(opts: { command: string; args: string[] }); listTools(): Promise<string[]>; call(name: string, args?: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }` — `call` internally retries once after transport failure.

- [ ] **Step 1: Add the SDK dependency**

Run: `cd packages/agent && bun add "@modelcontextprotocol/sdk@^1.30"`
Expected: package.json gains `"@modelcontextprotocol/sdk": "^1.30.0"` and the root `bun.lock` is updated. (This is the only new runtime dep in this plan.)

- [ ] **Step 2: Write the failing fixture first**

Create `packages/agent/tests/fixtures/fake-sentrux-mcp.cjs` (a minimal stdio JSON-RPC server mirroring `sentrux --mcp`):

```js
// tests/fixtures/fake-sentrux-mcp.cjs
// Minimal stdio MCP server mirroring sentrux --mcp for tests.
const readline = require("node:readline");

const TOOLS = [
  { name: "scan", description: "Scan a directory and compute all metrics.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "rescan", description: "Re-scan the current directory.", inputSchema: { type: "object" } },
  { name: "session_start", description: "Save health as baseline.", inputSchema: { type: "object" } },
  { name: "session_end", description: "Diff against baseline.", inputSchema: { type: "object" } },
  { name: "health", description: "Quality signal with root causes.", inputSchema: { type: "object" } },
  { name: "check_rules", description: "Check .sentrux/rules.toml.", inputSchema: { type: "object" } },
  { name: "git_stats", description: "Git history analysis.", inputSchema: { type: "object", properties: { days: { type: "integer" } } } },
  { name: "dsm", description: "Design structure matrix.", inputSchema: { type: "object", properties: { format: { type: "string" } } } },
  { name: "test_gaps", description: "Untested high-risk files.", inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
];

const rl = readline.createInterface({ input: process.stdin });
const respond = (req, payload) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...payload }) + "\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  switch (req.method) {
    case "initialize":
      respond(req, { result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-sentrux", version: "0.0.0" } } });
      break;
    case "tools/list":
      respond(req, { result: { tools: TOOLS } });
      break;
    case "tools/call": {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      if (args.kill === true) { process.exit(0); }
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        respond(req, { result: { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true } });
        break;
      }
      if (name === "scan") {
        respond(req, { result: { content: [{ type: "text", text: JSON.stringify({ scanned: args.path, quality_signal: 7342, files: 3 }) }] } });
        break;
      }
      respond(req, { result: { content: [{ type: "text", text: JSON.stringify({ tool: name, arguments: args, ok: true }) }] } });
      break;
    }
    case "ping":
      respond(req, { result: {} });
      break;
    default:
      respond(req, { error: { code: -32601, message: `Unknown method: ${req.method}` } });
  }
});
rl.on("close", () => process.exit(0));
```

- [ ] **Step 3: Write the failing test**

`packages/agent/tests/sentrux-mcp.test.ts`:

```ts
// tests/sentrux-mcp.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { SentruxMcpClient } from "../lib/sentrux-mcp";

const FIXTURE = path.join(import.meta.dirname, "fixtures/fake-sentrux-mcp.cjs");
const clients: SentruxMcpClient[] = [];
function client(): SentruxMcpClient {
  const c = new SentruxMcpClient({ command: process.execPath, args: [FIXTURE] });
  clients.push(c);
  return c;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("SentruxMcpClient", () => {
  test("lists the nine sentrux tools", async () => {
    const tools = await client().listTools();
    expect(tools).toEqual([
      "scan", "rescan", "session_start", "session_end", "health",
      "check_rules", "git_stats", "dsm", "test_gaps",
    ]);
  });

  test("call returns parsed JSON from the fixture", async () => {
    const r = await client().call("scan", { path: "/tmp/foo" });
    expect(r).toEqual({ scanned: "/tmp/foo", quality_signal: 7342, files: 3 });
  });

  test("call passes arguments through to the server", async () => {
    const r = await client().call("git_stats", { days: 30 });
    expect(r).toEqual({ tool: "git_stats", arguments: { days: 30 }, ok: true });
  });

  test("call with no arguments sends an empty object", async () => {
    const r = await client().call("health");
    expect(r).toEqual({ tool: "health", arguments: {}, ok: true });
  });

  test("surfaces server errors as thrown errors", async () => {
    await expect(client().call("nope")).rejects.toThrow(/Unknown tool/);
  });

  test("recovers after the server exits mid-session (one respawn)", async () => {
    const c = client();
    const first = await c.call("scan", { path: "/x" });
    expect(first).toEqual({ scanned: "/x", quality_signal: 7342, files: 3 });
    await c.call("scan", { path: "/x", kill: true }); // fixture exits
    const second = await c.call("scan", { path: "/y" });
    expect(second).toEqual({ scanned: "/y", quality_signal: 7342, files: 3 });
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd packages/agent && bun test tests/sentrux-mcp.test.ts`
Expected: FAIL — `Cannot find module "../lib/sentrux-mcp"`.

- [ ] **Step 5: Implement `packages/agent/lib/sentrux-mcp.ts`**

```ts
// lib/sentrux-mcp.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface SentruxMcpOptions {
  command: string;
  args: string[];
}

type McpTextContent = { type: "text"; text: string };
type McpContent = { type: string; text?: string } | { type: string };

function resultText(content: McpContent[] | undefined): string {
  return (content ?? [])
    .filter((p): p is McpTextContent => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * In-process MCP client for `sentrux --mcp` (stdio). One transport, one
 * reconnect+retry per call so a crashed server does not kill the turn.
 */
export class SentruxMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private readonly options: SentruxMcpOptions) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      stderr: "pipe",
    });
    const client = new Client({ name: "ei-sentrux", version: "0.1.0" });
    await client.connect(transport);
    this.transport = transport;
    this.client = client;
    return client;
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) {
      try { await client.close(); } catch { /* already gone */ }
    }
  }

  async listTools(): Promise<string[]> {
    const client = await this.connect();
    const { tools } = await client.listTools();
    return (tools ?? []).map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await this.callOnce(name, args);
    } catch {
      await this.disconnect();
      return this.callOnce(name, args);
    }
  }

  private async callOnce(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args });
    const text = resultText(result.content as McpContent[] | undefined);
    if (result.isError) throw new Error(text || `sentrux tool '${name}' failed`);
    if (text === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { text };
    }
  }

  async close(): Promise<void> {
    await this.disconnect();
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd packages/agent && bun test tests/sentrux-mcp.test.ts`
Expected: all pass (including the mid-session respawn test).

- [ ] **Step 7: Commit**

```bash
git add packages/agent/package.json bun.lock packages/agent/lib/sentrux-mcp.ts packages/agent/tests/fixtures/fake-sentrux-mcp.cjs packages/agent/tests/sentrux-mcp.test.ts
git commit -m "feat(agent): in-process MCP client for sentrux --mcp"
```

---

### Task 4: the nine sentrux eve tools

**Files:**
- Create: `packages/agent/agent/tools/sentrux.ts`
- Create: `packages/agent/tests/sentrux-tools.test.ts`

**Interfaces:**
- Consumes: `SentruxMcpClient` (Task 3), `ensureSentrux` (Task 1).
- Produces: named eve tools `sentruxScan`, `sentruxRescan`, `sentruxSessionStart`, `sentruxSessionEnd`, `sentruxHealth`, `sentruxCheckRules`, `sentruxGitStats`, `sentruxDsm`, `sentruxTestGaps`; test seam `setSentruxToolsClientFactoryForTests(fn: (() => Promise<SentruxMcpClient | null>) | null)`.

- [ ] **Step 1: Write the failing test**

`packages/agent/tests/sentrux-tools.test.ts`:

```ts
// tests/sentrux-tools.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  sentruxCheckRules, sentruxDsm, sentruxGitStats, sentruxHealth, sentruxRescan,
  sentruxScan, sentruxSessionEnd, sentruxSessionStart, sentruxTestGaps,
  setSentruxToolsClientFactoryForTests,
} from "../agent/tools/sentrux";
import { SentruxMcpClient } from "../lib/sentrux-mcp";

const FIXTURE = path.join(import.meta.dirname, "fixtures/fake-sentrux-mcp.cjs");
const clients: SentruxMcpClient[] = [];

async function fakeFactory(): Promise<SentruxMcpClient> {
  const c = new SentruxMcpClient({ command: process.execPath, args: [FIXTURE] });
  clients.push(c);
  return c;
}

afterEach(async () => {
  setSentruxToolsClientFactoryForTests(null);
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("sentrux eve tools", () => {
  test("each tool maps to its MCP name and passes input", async () => {
    setSentruxToolsClientFactoryForTests(fakeFactory);
    expect(await sentruxScan.execute({ path: "/repo" })).toEqual({ scanned: "/repo", quality_signal: 7342, files: 3 });
    expect(await sentruxHealth.execute({})).toEqual({ tool: "health", arguments: {}, ok: true });
    expect(await sentruxRescan.execute({})).toEqual({ tool: "rescan", arguments: {}, ok: true });
    expect(await sentruxSessionStart.execute({})).toEqual({ tool: "session_start", arguments: {}, ok: true });
    expect(await sentruxSessionEnd.execute({})).toEqual({ tool: "session_end", arguments: {}, ok: true });
    expect(await sentruxCheckRules.execute({})).toEqual({ tool: "check_rules", arguments: {}, ok: true });
    expect(await sentruxGitStats.execute({ days: 7 })).toEqual({ tool: "git_stats", arguments: { days: 7 }, ok: true });
    expect(await sentruxDsm.execute({ format: "stats" })).toEqual({ tool: "dsm", arguments: { format: "stats" }, ok: true });
    expect(await sentruxTestGaps.execute({ limit: 5 })).toEqual({ tool: "test_gaps", arguments: { limit: 5 }, ok: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/agent && bun test tests/sentrux-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/agent/agent/tools/sentrux.ts`**

```ts
// agent/tools/sentrux.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { ensureSentrux } from "../../lib/sentrux";
import { SentruxMcpClient } from "../../lib/sentrux-mcp";

type ClientFactory = () => Promise<SentruxMcpClient | null>;

let testFactory: ClientFactory | null = null;

function defaultClient(): Promise<SentruxMcpClient> {
  let cached: Promise<SentruxMcpClient> | null = null;
  return () => {
    cached ??= ensureSentrux().then((bin) => new SentruxMcpClient({ command: bin, args: ["--mcp"] }));
    return cached;
  };
}

const makeClient = defaultClient();

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (testFactory) {
    const client = await testFactory();
    if (!client) return null;
    return client.call(name, args);
  }
  return (await makeClient()).call(name, args);
}

/** Test seam — see tests/sentrux-tools.test.ts. */
export function setSentruxToolsClientFactoryForTests(fn: ClientFactory | null): void {
  testFactory = fn;
}

export const sentruxScan = defineTool({
  description:
    "Scan a directory and compute all sentrux metrics. Must be called before the other sentrux tools. Returns the quality signal (0-10000) plus file/line/edge counts.",
  inputSchema: z.object({ path: z.string().min(1) }),
  async execute(input) {
    return call("scan", input);
  },
});

export const sentruxRescan = defineTool({
  description: "Re-scan the directory from a previous sentrux scan to pick up file changes since then.",
  inputSchema: z.object({}),
  async execute(input) {
    return call("rescan", input);
  },
});

export const sentruxSessionStart = defineTool({
  description: "Save the current sentrux health metrics as the baseline for a later session_end comparison.",
  inputSchema: z.object({}),
  async execute(input) {
    return call("session_start", input);
  },
});

export const sentruxSessionEnd = defineTool({
  description: "Re-scan and compare against the saved baseline; returns pass/fail with the signal before/after and delta.",
  inputSchema: z.object({}),
  async execute(input) {
    return call("session_end", input);
  },
});

export const sentruxHealth = defineTool({
  description:
    "Get the sentrux quality signal with root-cause breakdown (modularity, acyclicity, depth, equality, redundancy) and the single bottleneck to focus on.",
  inputSchema: z.object({}),
  async execute(input) {
    return call("health", input);
  },
});

export const sentruxCheckRules = defineTool({
  description: "Check the .sentrux/rules.toml architectural constraints for the scanned project; returns pass/fail with violations.",
  inputSchema: z.object({}),
  async execute(input) {
    return call("check_rules", input);
  },
});

export const sentruxGitStats = defineTool({
  description: "Git history analysis for the scanned project: churn, hotspots, bus factor, change coupling. Raw data, not a score.",
  inputSchema: z.object({ days: z.number().int().min(1).optional() }),
  async execute(input) {
    return call("git_stats", input);
  },
});

export const sentruxDsm = defineTool({
  description: "Get the Design Structure Matrix for the scanned project: dependency matrix statistics and layering interpretation.",
  inputSchema: z.object({ format: z.enum(["text", "stats"]).optional() }),
  async execute(input) {
    return call("dsm", input);
  },
});

export const sentruxTestGaps = defineTool({
  description: "Find high-risk source files with no test coverage in the scanned project.",
  inputSchema: z.object({ limit: z.number().int().min(1).optional() }),
  async execute(input) {
    return call("test_gaps", input);
  },
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/agent && bun test tests/sentrux-tools.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck the whole package**

Run: `cd packages/agent && bun run typecheck`
Expected: clean (this validates `defineTool`/`eve/tools` typing and the zod schemas).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/agent/tools/sentrux.ts packages/agent/tests/sentrux-tools.test.ts
git commit -m "feat(agent): sentrux MCP tools for the agent"
```

---

### Task 5: the improve-loop instruction

**Files:**
- Create: `packages/agent/agent/instructions/03-improve.md`

**Interfaces:**
- Consumes: nothing; the tools from Task 4 by name. Produces: the protocol the model follows.

- [ ] **Step 1: Write `packages/agent/agent/instructions/03-improve.md`**

```md
# Improve loop

When the user asks you to improve a codebase ("improve <path>", "make the
dependency graph cleaner", "raise the quality score"), follow this bounded
loop. sentrux is your sensor: it scores the *structure* of the repo from
0 to 10000, and its `health` tool names the single worst root cause
(modularity, acyclicity, depth, equality, redundancy).

## Protocol

1. **Target.** Confirm the absolute path is a git repository. If the user
   gave no goal, the goal is: raise the sentrux quality signal. Check first
   whether a clean baseline exists (the repo may have uncommitted work —
   do not loop on a dirty tree without a `git stash` first, and say what
   you did).

2. **Baseline.** Call `sentrux_scan` with the repo path, then
   `sentrux_session_start`, then `sentrux_health`. Note the signal and the
   bottleneck.

3. **Plan.** Target the worst root cause with small, concrete refactors.
   Enumerate the edits before making them. Do not shotgun-edit.

4. **Loop.** Repeat until one of the stop conditions fires:
   - Make a small slice of edits with `bash`, `read_file`, `write_file`.
   - Run cheap project checks if the project has them (tests, typecheck),
     and fix what they flag.
   - Call `sentrux_rescan` and compare the signal to before the slice.
   - Improved → keep. `git add` the changes and commit with a message that
     cites the metric you moved (e.g. "improve acyclicity (0 pre-cycle → 0)").
   - Flat or worse → revert that slice (`git checkout -- <paths>`) and try
     a smaller or different change.
   - **Stop when any of**: the target is reached (or
     `EI_IMPROVE_TARGET` if set — read the env with `bash` when you need
     it), two consecutive rounds made no improvement, you hit
     `EI_IMPROVE_MAX_ROUNDS` (default 8), or two slices were reverted.

5. **Finish.** If the loop was net positive and the repo has a remote,
   push (never `--force`). Reply with: signal before → after, rounds run,
   commits made, files touched, and the remaining bottlenecks. If it made
   no progress, say so plainly and show what you tried instead of padding
   the reply.

## Rules

- The round cap is a hard bound. Never loop beyond it.
- Every kept change is one commit; never lose work to an uncommitted edit.
- Destructive shell commands, package installs, and service restarts are
  allowed (the host grant), but be deliberate and state what you did.
- Leave secrets and the Ei/VPS configuration out of repo content you touch.
```

- [ ] **Step 2: Sanity-check the instruction loads**

Run: `cd packages/agent && rg -n "Improve loop" agent/instructions/03-improve.md`
Expected: the file is present alongside `01-voice.md` / `02-style.md`.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/agent/instructions/03-improve.md
git commit -m "feat(agent): sentrux improve-loop instruction"
```

---

### Task 6: `ei doctor` / `ei setup` sentrux integration + docs

**Files:**
- Modify: `packages/agent/cli/commands/doctor.ts`
- Create: `packages/agent/cli/commands/doctor-sentrux.test.ts`
- Modify: `packages/agent/cli/commands/setup.ts`
- Modify: `packages/agent/cli/commands/setup.test.ts`
- Modify: `docs/ENV.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `resolveSentruxBin`, `ensureSentrux` from `../../lib/sentrux` (Task 1), `run` from `../run`.
- Produces: `checkSentrux(opts: { bin: string | null; run?: typeof run }): Promise<Check>`; `SetupAction` gains `"sentrux"`; `planSetup` gains `{ label: "install sentrux", action: "sentrux" }` after `build:agent`.

- [ ] **Step 1: Write the failing doctor test**

Create `packages/agent/cli/commands/doctor-sentrux.test.ts`:

```ts
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
    const check = await checkSentrux({ bin, run: async () => ({ ok: true, code: 0, stdout: "sentrux 0.5.7\n", stderr: "" }) });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("sentrux");
  });
  test("not ok when the binary is absent", async () => {
    const check = await checkSentrux({ bin: null });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("ei setup");
  });
  test("not ok when --version fails", async () => {
    const bin = await fakeBin("sentrux-broken", "#!/bin/sh\nexit 3\n");
    const check = await checkSentrux({ bin, run: async () => ({ ok: false, code: 3, stdout: "", stderr: "boom" }) });
    expect(check.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/agent && bun test cli/commands/doctor-sentrux.test.ts`
Expected: FAIL — `checkSentrux` is not exported.

- [ ] **Step 3: Modify `packages/agent/cli/commands/doctor.ts`**

Add the import to the existing import block:

```ts
import { resolveSentruxBin } from "../../lib/sentrux";
```

(`doctor.ts` already imports `run, requireBin, type RunResult` from `../run`.)

Then add this exported function (before `doctor`):

```ts
/** Doctor check for the sentrux sensor binary. */
export async function checkSentrux(opts: {
  bin: string | null;
  run?: typeof run;
}): Promise<Check> {
  const runner = opts.run ?? run;
  if (!opts.bin) {
    return { name: "sentrux", ok: false, detail: "not installed (ei setup installs it)" };
  }
  const version: RunResult = await runner([opts.bin, "--version"]);
  const detail = version.ok ? version.stdout.trim().split("\n")[0] : "sentrux --version failed";
  return { name: "sentrux", ok: version.ok && detail.length > 0, detail };
}
```

And inside `checkAll`, after the `postgres` check push:

```ts
  checks.push(await checkSentrux({ bin: opts.sentruxBin === undefined ? resolveSentruxBin() : opts.sentruxBin, run: runner }));
```

Extend the `checkAll` opts type to include `sentruxBin?: string | null`:

```ts
export async function checkAll(
  cfg: EiConfig,
  opts: { run?: typeof run; requireBin?: typeof requireBin; sentruxBin?: string | null } = {},
): Promise<Check[]> {
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `cd packages/agent && bun test cli/commands/doctor-sentrux.test.ts`
Expected: all pass.

- [ ] **Step 5: Update `packages/agent/cli/commands/setup.ts`**

1. Add `"sentrux"` to the `SetupAction` union:

```ts
export type SetupAction =
  | "preflight"
  | "doppler-setup"
  | "sentrux"
  | "install"
  | "typecheck"
  | "build"
  | "register"
  | "write-config"
  | "systemd"
  | "start";
```

2. Insert the step in `planSetup` between `build` and `register`:

```ts
    { label: "build:agent", action: "build" },
    { label: "install sentrux", action: "sentrux" },
    { label: "register-commands", action: "register" },
```

3. Add the import and the switch case:

```ts
import { ensureSentrux } from "../../lib/sentrux";
```

```ts
      case "sentrux":
        await runStep(step.label, async () => {
          try {
            const bin = await ensureSentrux();
            if (!bin) throw new Error("sentrux install produced no binary");
          } catch (err) {
            throw new Error(`sentrux install failed: ${(err as Error).message}`);
          }
        });
        break;
```

- [ ] **Step 6: Update `packages/agent/cli/commands/setup.test.ts`**

The ordered plan expectation gains `"install sentrux"` between `"build:agent"` and `"register-commands"`:

```ts
test("planSetup renders a deterministic ordered plan", () => {
  const plan = planSetup(cfg);
  expect(plan.map((s) => s.label)).toEqual([
    "Preflight",
    "doppler setup",
    "bun install",
    "typecheck",
    "build:agent",
    "install sentrux",
    "register-commands",
    "write config",
    "systemd unit",
    "start + health",
  ]);
});
```

- [ ] **Step 7: Run the CLI tests**

Run: `cd packages/agent && bun test cli/`
Expected: all pass.

- [ ] **Step 8: Update `docs/ENV.md`**

Append the sentrux block alongside the existing environment variables (match the file's existing bullet style):

```markdown
- `SENTRUX_PATH` — explicit path to the `sentrux` binary (skips auto-install; the agent installs it to `/usr/local/bin/sentrux` on first use otherwise).
- `EI_AGENT_ROOT` — root the host (unsandboxed) sandbox works from; defaults to `/`. Relative paths in agent file tools resolve here.
- `EI_IMPROVE_MAX_ROUNDS` — hard cap on improve-loop rounds (default `8`, read by the agent via the environment).
- `EI_IMPROVE_TARGET` — optional quality-signal target (0–10000) that ends the improve loop early.
```

- [ ] **Step 9: Update README.md**

In the agent section (near the scheduled-jobs / self-healing prose, after the evals paragraph), add:

```markdown
## Improve loop (sentrux)

Ask the agent to improve any git repo on the VPS ("improve /path/to/repo").
It installs the [sentrux](https://github.com/sentrux/sentrux) sensor on first
use, scans the repo through sentrux's MCP server (in-process, stdio), then
runs a bounded loop: plan a small refactor targeting the worst root cause
(modularity, acyclicity, depth, equality, redundancy), edit with the
host-backed file/shell tools, rescan, keep-or-revert, and commit each kept
change. It stops at the target score, two flat rounds, or `EI_IMPROVE_MAX_ROUNDS`
(default 8), then commits (and pushes, never force) and reports the
before/after signal in Discord. The agent is unsandboxed by design — it has
root access to the whole VPS from `EI_AGENT_ROOT` (`/`).
```

- [ ] **Step 10: Typecheck + full CLI test pass, commit**

Run: `cd packages/agent && bun run typecheck && bun test cli/`
Expected: clean, all pass.

```bash
git add packages/agent/cli/commands/doctor.ts packages/agent/cli/commands/doctor-sentrux.test.ts packages/agent/cli/commands/setup.ts packages/agent/cli/commands/setup.test.ts docs/ENV.md README.md
git commit -m "feat(cli): sentrux doctor check and setup step, docs"
```

---

### Task 7: build the binary, full verification, and a live smoke

**Files:**
- None (verification + one optional live smoke on a scratch repo).

**Interfaces:**
- Consumes: everything from Tasks 1–6.

- [ ] **Step 1: Full test suite + typechecks**

Run:
```bash
cd /root/dev/projects/Ei && bun run typecheck
cd packages/agent && bun test
```
Expected: `bun test` green (existing 144 + the new suites), both typechecks clean, `sh -n install.sh` unaffected.

- [ ] **Step 2: Verify the agent still builds under eve**

Run: `cd packages/agent && bun run build:shared && bunx eve build` (in the agent package; or the root `build:agent` alias used by `ei setup`)
Expected: eve build succeeds with the new sandbox definition + tools + instruction (watch for template/sandbox provisioning errors — the host backend's `prewarm` returns `{ reused: false }`, so none should appear).

- [ ] **Step 3: Rebuild the CLI binary and smoke `ei doctor`/`ei setup`**

Run (from repo root):
```bash
bun run build:cli
./ei-linux-x64 doctor --json
./ei-linux-x64 setup --dry-run
```
Expected: doctor JSON includes a `sentrux` row (ok or not-installed); setup --dry-run lists `install sentrux` in the plan card.

- [ ] **Step 4: Live smoke on a scratch repo (manual, not CI)**

```bash
# scratch git repo so sentrux has something to scan
rm -rf /tmp/ei-smoke && mkdir -p /tmp/ei-smoke/src && cd /tmp/ei-smoke \
  && git init -q && for i in 1 2 3 4 5; do printf 'export const v%d = %d;\n' "$i" "$i" > src/g$i.ts; done \
  && git add -A && git commit -qm init

# install + one real MCP round-trip against the sentrux server
cd /root/dev/projects/Ei/packages/agent
bun -e "
import { ensureSentrux } from './lib/sentrux.ts';
import { SentruxMcpClient } from './lib/sentrux-mcp.ts';
const bin = await ensureSentrux();
console.log('sentrux at', bin);
const c = new SentruxMcpClient({ command: bin, args: ['--mcp'] });
console.log('tools:', (await c.listTools()).join(', '));
console.log('scan:', JSON.stringify(await c.call('scan', { path: '/tmp/ei-smoke' })));
await c.close();
"
```
Expected: `tools:` lists all nine names; `scan:` prints a real quality signal for `/tmp/ei-smoke`. If the sandbox blocks the release download, install sentrux manually first (`curl -fsSL https://raw.githubusercontent.com/sentrux/sentrux/main/install.sh | sh`) and re-run — `resolveSentruxBin` picks it up.

- [ ] **Step 5: Commit any stragglers and report**

```bash
git status --short
```
Expected: clean tree, or only intentional leftovers. Commit any guard fixes with a `fix:` or `chore:` message, then run the finishing-a-development-branch wrap-up.

---

## Self-Review notes (author)

- Spec coverage: host backend → Task 2; nine MCP tools → Task 4; SDK client → Task 3; improve loop → Task 5; doctor/setup/env/README → Task 6; error handling (install failure, MCP retry, loop bound) → Tasks 1/3/5; testing matrix → each task's tests + Task 7.
- `git_stats` naming corrected from the spec's earlier "evolution" row; the spec file was updated to match before this plan was written.
- No placeholders: every code block above is complete and typed. Tests assert behavior through the fixture MCP server round-trip, not zod introspection, so they hold on zod 4 without adjustment.
