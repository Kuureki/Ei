import { defineAgent, defineDynamic } from "eve";
import { getExecutor, migrate } from "../lib/db";
import { shouldStartGateway, startGateway } from "../lib/gateway/index";
import { resolveStepModel } from "../lib/model";

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
if (shouldStartGateway(process.env)) {
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
