import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { parseSchedulePrompt, formatNextRun, validateCadence, type ScheduledCadenceInput } from "../../lib/schedule-admin";
import { appendLineageTag, updateSchedule } from "../../lib/schedule-store";

const LINEAGE_VARIATION = z.enum(["A", "B", "C", "D"]);

export default defineTool({
  description:
    "Change, pause, or resume a scheduled job. Updates cadence/timezone and recomputes the next run. Pass lineage: { variation } when applying a chosen lineage prompt variation so the pick is recorded.",
  inputSchema: z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100).optional(),
    prompt: z.string().min(1).max(4000).optional(),
    cadenceText: z.string().optional(),
    everyMinutes: z.number().int().positive().optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    weekly: z.array(z.number().int().min(0).max(6)).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    timezone: z.string().optional(),
    enabled: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    lineage: z.object({ variation: LINEAGE_VARIATION }).optional(),
  }),
  approval: always(),
  async execute(input) {
    const ex = getExecutor();
    let cadence: ScheduledCadenceInput | undefined;
    if (input.cadenceText) {
      const parsed = parseSchedulePrompt(input.cadenceText);
      if (!parsed) throw new Error(`Could not parse cadence "${input.cadenceText}".`);
      cadence = parsed;
    } else if (input.everyMinutes) {
      cadence = { kind: "every_minutes", everyMinutes: input.everyMinutes };
    } else if (input.time && input.dayOfMonth) {
      cadence = { kind: "monthly_on", dayOfMonth: input.dayOfMonth, time: input.time };
    } else if (input.time && (input.weekly ?? []).length) {
      cadence = { kind: "weekly_on", time: input.time, weekly: input.weekly ?? [] };
    } else if (input.time) {
      cadence = { kind: "daily_at", time: input.time };
    }
    if (cadence) validateCadence(cadence);
    const row = await updateSchedule(ex, input.id, {
      name: input.name,
      prompt: input.prompt,
      cadence,
      timezone: input.timezone,
      enabled: input.enabled,
      tags: input.tags,
    });
    if (!row) throw new Error("No schedule with that id/name.");
    if (input.lineage) {
      const marked = await appendLineageTag(ex, row.id, input.lineage.variation);
      if (!marked) throw new Error("Could not record the lineage pick.");
      return {
        updated: true,
        nextRun: formatNextRun(new Date(marked.next_run_at), marked.timezone),
        lineage: { generation: nextGenerationOf(marked.tags), variation: input.lineage.variation },
      };
    }
    return { updated: true, nextRun: formatNextRun(new Date(row.next_run_at), row.timezone) };
  },
});

function nextGenerationOf(tags: unknown): number | null {
  if (!Array.isArray(tags)) return null;
  const gens = tags
    .map((t) => (t && typeof t === "object" && "lineage" in t ? (t as { lineage?: { generation?: unknown } }).lineage?.generation : null))
    .filter((g): g is number => typeof g === "number");
  return gens.length ? Math.max(...gens) : null;
}
