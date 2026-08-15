// lib/sentrux-tools.ts
// Shared client plumbing for the sentrux eve tools (agent/tools/sentrux/*.ts).
// Lives in lib/ because every file under tools/ must be a single tool module.
import { ensureSentrux } from "./sentrux";
import { SentruxMcpClient } from "./sentrux-mcp";

type ClientFactory = () => Promise<SentruxMcpClient | null>;

let testFactory: ClientFactory | null = null;
let cachedClient: Promise<SentruxMcpClient> | null = null;

async function makeClient(): Promise<SentruxMcpClient> {
  cachedClient ??= ensureSentrux().then((bin) => new SentruxMcpClient({ command: bin, args: ["--mcp"] }));
  return cachedClient;
}

export async function callSentrux(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
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