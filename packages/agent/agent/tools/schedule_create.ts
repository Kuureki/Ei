import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { parseSchedulePrompt, formatNextRun, validateCadence, type ScheduledCadenceInput } from "../../lib/schedule-admin";
import { createSchedule } from "../../lib/schedule-store";

export default defineTool({
  description:
    "Create a scheduled job that runs on a cadence and reports to your DMs. Provide the cadence as plain text (e.g. 'every 30 minutes', 'daily at 09:00', 'weekdays at 08:00', 'monthly on the 3rd at 12:00') or as structured fields. Confirm cadence, timezone, and target before creating.",
  inputSchema: z.object({
    name: z.string().min(1).max(100),
    prompt: z.string().min(1).max(4000),
    cadenceText: z.string().optional(),
    everyMinutes: z.number().int().positive().optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    weekly: z.array(z.number().int().min(0).max(6)).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    timezone: z.string().optional(),
    firstRunAt: z.string().datetime({ offset: true }).optional(),
    tags: z.array(z.string()).optional(),
  }),
  approval: always(),
  async execute(input, ctx) {
    const ex = getExecutor();
    let cadence: ScheduledCadenceInput;
    if (input.cadenceText) {
      const parsed = parseSchedulePrompt(input.cadenceText);
      if (!parsed) throw new Error(`Could not parse cadence "${input.cadenceText}". Use structured fields or rephrase.`);
      cadence = parsed;
    } else if (input.everyMinutes) {
      cadence = { kind: "every_minutes", everyMinutes: input.everyMinutes };
    } else if (input.time && input.dayOfMonth) {
      cadence = { kind: "monthly_on", dayOfMonth: input.dayOfMonth, time: input.time };
    } else if (input.time && (input.weekly ?? []).length) {
      cadence = { kind: "weekly_on", time: input.time, weekly: input.weekly ?? [] };
    } else if (input.time) {
      cadence = { kind: "daily_at", time: input.time };
    } else {
      throw new Error("Provide cadenceText or structured cadence fields (everyMinutes, or time with weekly/dayOfMonth).");
    }
    validateCadence(cadence);

    const auth = ctx.session.auth.current;
    const principalId = auth?.principalId ?? ctx.session.auth.initiator?.principalId ?? "owner";
    const guildId = typeof auth?.attributes?.guild_id === "string" ? auth.attributes.guild_id : "0";
    const channelId = typeof auth?.attributes?.channel_id === "string" ? auth.attributes.channel_id : "0";

    const row = await createSchedule(ex, {
      name: input.name,
      prompt: input.prompt,
      cadence,
      timezone: input.timezone,
      firstRunAt: input.firstRunAt,
      tags: input.tags,
      owner: { principalId, guildId, channelId },
    });
    return {
      scheduleId: row.id,
      name: row.name,
      nextRun: formatNextRun(new Date(row.next_run_at), row.timezone),
    };
  },
});
