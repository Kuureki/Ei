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
