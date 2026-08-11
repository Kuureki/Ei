// Autoresearch lineage: pick the worst-health eligible schedule weekly and
// propose prompt variations. Pure target selection + directive text.
import type { SqlExecutor } from "./db";
import { jsonValue } from "./db";
import { PENDING_TTL_MS } from "./gate";
import { assessSchedules, type HealthStatus } from "./health";

export const LINEAGE_VARIATIONS = ["A", "B", "C", "D"] as const;
export type LineageVariation = (typeof LINEAGE_VARIATIONS)[number];

export interface LineageTarget {
  scheduleId: string;
  name: string;
  prompt: string;
  timezone: string;
  health: HealthStatus;
  guildId: string;
  dmChannelId: string;
  dmThreadId: string | null;
}

const HEALTH_PRIORITY: Record<HealthStatus, number> = {
  critical: 0,
  degraded: 1,
  stale: 2,
  healthy: 3,
  "no-data": 4,
};

interface LineageTag {
  lineage?: { generation?: unknown; variation?: unknown; applied_at?: unknown };
}

function lineageTags(tags: unknown): LineageTag[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is LineageTag => typeof t === "object" && t !== null);
}

function lineageAppliedAt(tags: unknown): number | null {
  let latest: number | null = null;
  for (const entry of lineageTags(tags)) {
    const applied = entry.lineage?.applied_at;
    if (typeof applied !== "string") continue;
    const ms = new Date(applied).getTime();
    if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

export function nextLineageGeneration(tags: unknown): number {
  let max = 0;
  for (const entry of lineageTags(tags)) {
    const gen = entry.lineage?.generation;
    if (typeof gen === "number" && Number.isInteger(gen) && gen > max) max = gen;
  }
  return max + 1;
}

// Pick the lineage target: worst health, then least-recently-updated. Skips
// no-data schedules, disabled schedules, empty prompts, a live pending gate,
// and schedules whose last lineage application is within PENDING_TTL_MS.
export async function selectLineageTarget(
  ex: SqlExecutor,
  opts: { now: Date; pending: { scheduleId: string; at: string } | null },
): Promise<LineageTarget | null> {
  const now = opts.now;
  if (opts.pending && now.getTime() - new Date(opts.pending.at).getTime() < PENDING_TTL_MS) return null;
  const assessments = await assessSchedules(ex, { now });
  if (!assessments.length) return null;

  const r = await ex.query(`select id, updated_at, tags from ei_schedules where enabled`);
  const updatedAt = new Map<string, number>();
  const tagsOf = new Map<string, unknown>();
  for (const row of r.rows) {
    updatedAt.set(String(row.id), new Date(String(row.updated_at)).getTime());
    tagsOf.set(String(row.id), jsonValue(row.tags));
  }

  const eligible = assessments
    .filter((a) => a.status !== "no-data" && a.prompt.trim().length > 0)
    .filter((a) => {
      const applied = lineageAppliedAt(tagsOf.get(a.scheduleId));
      return applied === null || now.getTime() - applied >= PENDING_TTL_MS;
    })
    .sort((a, b) => {
      const byHealth = HEALTH_PRIORITY[a.status] - HEALTH_PRIORITY[b.status];
      if (byHealth !== 0) return byHealth;
      const byAge = (updatedAt.get(a.scheduleId) ?? 0) - (updatedAt.get(b.scheduleId) ?? 0);
      if (byAge !== 0) return byAge;
      return a.scheduleId.localeCompare(b.scheduleId);
    });

  const pick = eligible[0];
  if (!pick) return null;
  return {
    scheduleId: pick.scheduleId,
    name: pick.name,
    prompt: pick.prompt,
    timezone: pick.timezone,
    health: pick.status,
    guildId: pick.guildId,
    dmChannelId: pick.dmChannelId,
    dmThreadId: pick.dmThreadId,
  };
}

export function buildLineageDirective(target: LineageTarget): string {
  return [
    `Lineage target: ${target.name} (${target.scheduleId}), health ${target.health}.`,
    `Current prompt: ${target.prompt}`,
    "",
    "Draft 4 variations of this schedule's prompt, each labeled:",
    "**A — better inputs/trigger**",
    "**B — sharper output/format**",
    "**C — more robust (fallbacks, error handling)**",
    "**D — rethink the approach**",
    "",
    "End with a one-line confidence ranking. Make no changes — wait for my pick.",
  ].join("\n");
}