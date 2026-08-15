import { defineAgent, defineDynamic } from "eve";
import { getExecutor, migrate } from "../lib/db";
import { shouldStartGateway, startGateway } from "../lib/gateway/index";
import { resolveStepModel } from "../lib/model";

// eve start evaluates this entry module twice per boot: once in the CLI
// process (while prewarming sandboxes it imports the built entry to resolve
// the agent graph) and once in the spawned built-server child. Discord
// gateway + migrate must run only in the server child; eve sets
// NITRO_PORT/HOST/NITRO_HOST exclusively on that spawned process. The
// process-global flag additionally guards against any same-process double
// evaluation.
const isServerChild =
  process.env.NITRO_PORT !== undefined || process.env.HOST !== undefined;
const globalThis_ = globalThis as Record<string, unknown>;
if (isServerChild && shouldStartGateway(process.env) && globalThis_.__EI_AGENT_BOOTED !== true) {
  globalThis_.__EI_AGENT_BOOTED = true;

  // Postgres is required. migrate() connects and creates/verifies the tables;
  // failure here is fatal so systemd restarts (same shape as the gateway fatal).
  void (async () => {
    try {
      await migrate(getExecutor());
    } catch (err) {
      console.error("postgres boot failed", err);
      process.exit(1);
    }
  })();

  // In-process Discord gateway (messages -> /intake, interactions -> /interact).
  // Surface fatal gateway errors so systemd restarts the whole service.
  startGateway().catch((err) => {
    console.error("gateway fatal", err);
    process.exit(1);
  });
}

export default defineAgent({
  build: {
    // Native .node binaries (anydoc) must stay external: bundling them fails.
    externalDependencies: [
      "@firecrawl/anydoc-linux-x64-gnu",
      "@firecrawl/anydoc-linux-x64-musl",
    ],
  },
  model: defineDynamic({
    fallback: "anthropic/claude-sonnet-5",
    events: {
      "step.started": async () => resolveStepModel(process.env as Record<string, string | undefined>),
    },
  }),
  modelContextWindowTokens: 250_000,
  experimental: {
    workflow: {
      world: "@workflow/world-postgres", // always; Postgres is required (§ spec 2026-08-12)
    },
  },
});
