// tests/sentrux-tools.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import scan from "../agent/tools/sentrux/scan";
import rescan from "../agent/tools/sentrux/rescan";
import sessionStart from "../agent/tools/sentrux/session_start";
import sessionEnd from "../agent/tools/sentrux/session_end";
import health from "../agent/tools/sentrux/health";
import checkRules from "../agent/tools/sentrux/check_rules";
import gitStats from "../agent/tools/sentrux/git_stats";
import dsm from "../agent/tools/sentrux/dsm";
import testGaps from "../agent/tools/sentrux/test_gaps";
import { setSentruxToolsClientFactoryForTests } from "../lib/sentrux-tools";
import { SentruxMcpClient } from "../lib/sentrux-mcp";

const FIXTURE = path.join(import.meta.dirname, "fixtures/fake-sentrux-mcp.cjs");
const clients: SentruxMcpClient[] = [];

async function fakeFactory(): Promise<SentruxMcpClient> {
  const c = new SentruxMcpClient({ command: process.execPath, args: [FIXTURE] });
  clients.push(c);
  return c;
}

// eve's execute(input, ctx) takes a ToolContext; these tools don't use it.
const ctx = { abortSignal: new AbortController().signal, callId: "sentrux-tools-test" } as never;

afterEach(async () => {
  setSentruxToolsClientFactoryForTests(null);
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("sentrux eve tools", () => {
  test("each tool maps to its MCP name and passes input", async () => {
    setSentruxToolsClientFactoryForTests(fakeFactory);
    expect(await scan.execute({ path: "/repo" }, ctx)).toEqual({ scanned: "/repo", quality_signal: 7342, files: 3 });
    expect(await health.execute({}, ctx)).toEqual({ tool: "health", arguments: {}, ok: true });
    expect(await rescan.execute({}, ctx)).toEqual({ tool: "rescan", arguments: {}, ok: true });
    expect(await sessionStart.execute({}, ctx)).toEqual({ tool: "session_start", arguments: {}, ok: true });
    expect(await sessionEnd.execute({}, ctx)).toEqual({ tool: "session_end", arguments: {}, ok: true });
    expect(await checkRules.execute({}, ctx)).toEqual({ tool: "check_rules", arguments: {}, ok: true });
    expect(await gitStats.execute({ days: 7 }, ctx)).toEqual({ tool: "git_stats", arguments: { days: 7 }, ok: true });
    expect(await dsm.execute({ format: "stats" }, ctx)).toEqual({ tool: "dsm", arguments: { format: "stats" }, ok: true });
    expect(await testGaps.execute({ limit: 5 }, ctx)).toEqual({ tool: "test_gaps", arguments: { limit: 5 }, ok: true });
  });
});
