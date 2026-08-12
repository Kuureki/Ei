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

// eve's execute(input, ctx) takes a ToolContext; these tools don't use it.
const ctx = { abortSignal: new AbortController().signal, callId: "sentrux-tools-test" } as never;

afterEach(async () => {
  setSentruxToolsClientFactoryForTests(null);
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("sentrux eve tools", () => {
  test("each tool maps to its MCP name and passes input", async () => {
    setSentruxToolsClientFactoryForTests(fakeFactory);
    expect(await sentruxScan.execute({ path: "/repo" }, ctx)).toEqual({ scanned: "/repo", quality_signal: 7342, files: 3 });
    expect(await sentruxHealth.execute({}, ctx)).toEqual({ tool: "health", arguments: {}, ok: true });
    expect(await sentruxRescan.execute({}, ctx)).toEqual({ tool: "rescan", arguments: {}, ok: true });
    expect(await sentruxSessionStart.execute({}, ctx)).toEqual({ tool: "session_start", arguments: {}, ok: true });
    expect(await sentruxSessionEnd.execute({}, ctx)).toEqual({ tool: "session_end", arguments: {}, ok: true });
    expect(await sentruxCheckRules.execute({}, ctx)).toEqual({ tool: "check_rules", arguments: {}, ok: true });
    expect(await sentruxGitStats.execute({ days: 7 }, ctx)).toEqual({ tool: "git_stats", arguments: { days: 7 }, ok: true });
    expect(await sentruxDsm.execute({ format: "stats" }, ctx)).toEqual({ tool: "dsm", arguments: { format: "stats" }, ok: true });
    expect(await sentruxTestGaps.execute({ limit: 5 }, ctx)).toEqual({ tool: "test_gaps", arguments: { limit: 5 }, ok: true });
  });
});
