import { defineSchedule } from "eve/schedules";
import discord from "../channels/discord";
import { getExecutor } from "../../lib/db";
import { PENDING_TTL_MS, readGate, writeGate } from "../../lib/gate";
import { buildLineageDirective, selectLineageTarget } from "../../lib/lineage";

// Weekly autoresearch lineage: pick the worst-health eligible schedule and
// ask the session agent to draft prompt variations A-D. The handler never
// mutates schedules; the user's pick is applied through schedule_update.
export default defineSchedule({
  cron: "0 11 * * 1",
  async run({ to, waitUntil, appAuth }) {
    const ex = getExecutor();
    await waitUntil(
      (async () => {
        const pendingRaw = (await readGate(ex, "lineage:pending")) as { scheduleId?: string; at?: string } | null;
        const pending =
          pendingRaw && typeof pendingRaw.at === "string"
            ? { scheduleId: pendingRaw.scheduleId ?? "", at: pendingRaw.at }
            : null;
        if (pending && Date.now() - new Date(pending.at).getTime() < PENDING_TTL_MS) return;
        const target = await selectLineageTarget(ex, { now: new Date(), pending });
        if (!target) return; // nothing to improve: stay silent
        await writeGate(ex, "lineage:pending", { scheduleId: target.scheduleId, at: new Date().toISOString() });
        await to(discord, {
          guildId: target.guildId,
          channelId: target.dmChannelId,
          threadId: target.dmThreadId ?? undefined,
        }).send(buildLineageDirective(target), { auth: appAuth });
      })(),
    );
  },
});