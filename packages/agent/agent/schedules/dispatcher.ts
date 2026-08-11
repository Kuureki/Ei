import { defineSchedule } from "eve/schedules";
import discord from "../channels/discord";
import { getExecutor } from "../../lib/db";
import { runDispatchCycle } from "../../lib/schedule-dispatch";

export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil, appAuth }) {
    const ex = getExecutor();
    if (!ex) return; // Postgres absent: nothing to dispatch; agent still boots.
    await waitUntil(
      runDispatchCycle(ex, {
        now: new Date(),
        limit: 25,
        leaseForMs: 5 * 60_000,
        deliver: async (job) => {
          await to(discord, {
            guildId: job.guild_id,
            channelId: job.dm_channel_id,
            threadId: job.dm_thread_id ?? undefined,
            scheduleRunId: job.runId,
          }).send(
            [job.prompt, "This is a scheduled job. Report done (or ask for help) concisely."].join("\n\n"),
            { auth: appAuth },
          );
        },
      }),
    );
  },
});
