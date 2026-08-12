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
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        respond(req, { result: { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true } });
        break;
      }
      if (args.kill === true) {
        // respond first, then drop the connection so the client must respawn
        respond(req, { result: { content: [{ type: "text", text: JSON.stringify({ tool: name, arguments: args, ok: true }) }] } });
        setImmediate(() => process.exit(0));
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
