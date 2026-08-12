// lib/sentrux-mcp.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface SentruxMcpOptions {
  command: string;
  args: string[];
}

type McpTextContent = { type: "text"; text: string };
type McpContent = { type: string; text?: string };

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
      try {
        await client.close();
      } catch {
        /* already gone */
      }
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
