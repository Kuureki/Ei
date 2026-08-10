import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  experimental: {
    workflow: {
      // Production: set WORKFLOW_TARGET_WORLD=@workflow/world-postgres (and
      // WORKFLOW_POSTGRES_URL) in the env file. Defaults to the local world
      // so `eve dev` needs no database.
      world:
        process.env.WORKFLOW_TARGET_WORLD === "@workflow/world-postgres"
          ? "@workflow/world-postgres"
          : "@workflow/world-local",
    },
  },
});
