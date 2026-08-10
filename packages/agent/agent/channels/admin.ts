import { defineChannel, POST } from "eve/channels";
import { getExecutor, migrate, type SqlExecutor } from "../../lib/db";
import { serviceAdminEvent, type CommandModule } from "../../lib/admin";
import * as commands from "../../lib/commands";
import type { InteractionEvent } from "../../lib/gateway/gateway";

const commandModule: CommandModule = {
  handleCommand: commands.handleCommand,
  handleAutocomplete: commands.handleAutocomplete,
  handleModalSubmit: commands.handleModalSubmit,
};

export default defineChannel({
  routes: [
    POST("/interact", async (request) => {
      if (request.headers.get("x-eve-connector-secret") !== process.env.EVE_CONNECTOR_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const body = (await request.json()) as { interaction?: InteractionEvent };
      const interaction = body.interaction;
      if (!interaction) return new Response("bad request", { status: 400 });
      const ownerId = process.env.AGENT_OWNER_DISCORD_ID ?? "";
      if (ownerId && interaction.userId !== ownerId) return new Response("ignored", { status: 200 });
      const ex = getExecutor();
      if (!ex) return new Response("no database", { status: 200 }); // config surface unavailable; the agent still runs on the fallback model
      await migrate(ex).catch(() => {});
      await serviceAdminEvent(interaction, {
        appId: process.env.DISCORD_APP_ID ?? "",
        ex: ex as SqlExecutor,
        env: process.env as Record<string, string | undefined>,
        fetchImpl: fetch,
        commands: commandModule,
      });
      return new Response("ok", { status: 200 });
    }),
  ],
  events: {},
});
