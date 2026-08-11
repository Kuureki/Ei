import { defineSchedule } from "eve/schedules";
import discord from "../channels/discord";
import { getExecutor } from "../../lib/db";
import { readGate, writeGate } from "../../lib/gate";
import { assessSchedules, buildHealthDirective, reconcileIssues, stableReportHash } from "../../lib/health";

// Daily self-healing assessment (detect + propose only). The handler never
// calls LLM APIs or mutates schedules; it assesses, opens/resolves issue rows,
// and injects a plain directive into the affected schedule's thread.
export default defineSchedule({
  cron: "0 9 * * *",
  async run({ to, waitUntil, appAuth }) {
    const ex = getExecutor();
    if (!ex) return; // Postgres absent: nothing to assess; agent still boots.
    await waitUntil(
      (async () => {
        const before = (await readGate(ex, "health:last_report")) as { hash?: unknown } | null;
        const now = new Date();
        const assessments = await assessSchedules(ex, { now });
        const findings = await reconcileIssues(ex, assessments, { now });
        const hash = stableReportHash(assessments);
        if (hash === before?.hash) return; // steady state: stay silent
        // Write the gate only AFTER the sends: a failed send re-fires on the
        // next daily tick because the gate still differs.
        for (const f of findings.newOrChanged) {
          await to(discord, {
            guildId: f.schedule.guildId,
            channelId: f.schedule.dmChannelId,
            threadId: f.schedule.dmThreadId ?? undefined,
          }).send(buildHealthDirective(f), { auth: appAuth });
        }
        await writeGate(ex, "health:last_report", { hash, at: now.toISOString() });
      })(),
    );
  },
});