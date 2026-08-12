// agent/tools/sentrux.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { ensureSentrux } from "../../lib/sentrux";
import { SentruxMcpClient } from "../../lib/sentrux-mcp";

type ClientFactory = () => Promise<SentruxMcpClient | null>;

let testFactory: ClientFactory | null = null;
let cachedClient: Promise<SentruxMcpClient> | null = null;

async function makeClient(): Promise<SentruxMcpClient> {
  cachedClient ??= ensureSentrux().then((bin) => new SentruxMcpClient({ command: bin, args: ["--mcp"] }));
  return cachedClient;
}

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
