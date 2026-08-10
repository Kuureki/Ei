import { defineAgent, defineDynamic } from "eve";
import { getExecutor, migrate } from "../lib/db";
import { shouldStartGateway, startGateway } from "../lib/gateway/index";
import { resolveStepModel } from "../lib/model";

// Boot migration is idempotent and best-effort; the agent must boot without Postgres.
void (async () => {
  const ex = getExecutor();
  if (ex) await migrate(ex).catch((err) => console.error("ei migrate failed", err));
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
  model: defineDynamic({
    fallback: "anthropic/claude-sonnet-5",
    events: {
      "step.started": async () => resolveStepModel(process.env as Record<string, string | undefined>),
    },
  }),
  experimental: {
    workflow: {
      // Production: set WORKFLOW_TARGET_WORLD=@workflow/world-postgres (and
      // WORKFLOW_POSTGRES_URL). Defaults to the zero-DB local world.
      world:
        process.env.WORKFLOW_TARGET_WORLD === "@workflow/world-postgres"
          ? "@workflow/world-postgres"
          : "@workflow/world-local",
    },
  },
});
