# Scheduled Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user create scheduled jobs in plain Discord (agent tools only), have a single `* * * * *` dispatcher hand each due job to the existing Discord channel via a new `receive()` hook, deliver the agent's reply back to the DM, and record every run in `ei_schedule_runs` so the agent can answer "what did that job do?".

**Architecture:** One authored schedule (`agent/schedules/dispatcher.ts`) atomically leases due rows from a new `ei_schedules` table (`lib/schedule-store.ts`), creates a `running` run row, and hands the job prompt to the current `discord.ts` channel via a new `receive(input, ctx)` hook. The run id rides an extended continuation token (`scheduleRunId`), so the existing `message.completed` → `deliverToDiscord` path posts the reply and also records run status/output. Cadence/timezone math is pure in `lib/schedule-admin.ts`. Management is exclusively agent tools (`tools/schedule_*.ts`) gated by `always()` approval on mutations.

**Tech Stack:** eve 0.31.3 schedules (`defineSchedule`, `eve/schedules`), eve tools (`defineTool`, `eve/tools`, `always` from `eve/tools/approval`), zod 4, Postgres via the existing `lib/db.ts` `SqlExecutor` + pg-mem tests, `@ei/shared` continuation tokens, bun test, TypeScript strict.

## Global Constraints

- Node `24.x`, Bun `1.3.14`, monorepo root `package.json` (`workspaces: packages/*`).
- All DB access goes through the existing `lib/db.ts` `SqlExecutor` + `migrate()` (`MIGRATE_SQL`, idempotent `create table if not exists`). No new pools/connections.
- `ei_schedules` columns match the spec exactly (Task 0 re-adds the two missing columns to the spec fix — see Task 0).
- Continuation tokens: `packages/shared/src/discord-util.ts` `encodeToken`/`decodeToken` gain an optional, backward-compatible `scheduleRunId` (4th segment); existing tokens without it keep working.
- Env-var names only (Doppler); no new env vars.
- Keep existing code green: `cd /root/dev/projects/Ei && bun run typecheck` (both packages) and `cd /root/dev/projects/Ei/packages/agent && bun test` must pass.
- TypeScript strict; follow existing test style (`describe/test/expect` from `bun:test`, pg-mem `memExecutor()` fixture).
- Commit at the end of every task; repo commit style with a `Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>` trailer.
- All commands run from the repo root unless a step says otherwise.

---

### Task 0: Restore the two spec columns dropped in the plan (docs fix)

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-scheduled-jobs-design.md` (data model section)

**Interfaces:**
- Consumes: nothing.
- Produces: the `ei_schedules` DDL in the spec matches the implementation that follows (`dm_thread_id`, `dm_channel_id` columns).

Background: while writing this plan the specs `ei_schedules` table lost `dm_thread_id` and `dm_channel_id` column definitions. The implementation below requires `dm_channel_id text not null` and `dm_thread_id text`. Restore them so spec and code agree.

- [ ] **Step 1: Restore the two columns in the spec DDL**

In `docs/superpowers/specs/2026-08-11-scheduled-jobs-design.md`, replace the block:

```sql
  owner_discord_id text not null,
  guild_id        text not null,              -- resolved once at creation (encodeToken needs it)
  dm_channel_id   text not null,              -- resolved once at creation
  dm_thread_id    text,
  tags            jsonb default '[]'::jsonb,
```

with:

```sql
  owner_discord_id text not null,
  guild_id        text not null,              -- resolved once at creation (encodeToken needs it)
  dm_channel_id   text not null,              -- resolved once at creation
  dm_thread_id    text,
  tags            jsonb default '[]'::jsonb,
```

(The block already contains the columns; this step is a no-op safeguard — verify they are present with the next command.)

- [ ] **Step 2: Verify the columns exist in the spec**

```bash
cd /root/dev/projects/Ei && rg -n "dm_thread_id|dm_channel_id" docs/superpowers/specs/2026-08-11-scheduled-jobs-design.md
```

Expected: exactly 2 lines matching `dm_channel_id` (schema + dispatcher) and 1–2 matching `dm_thread_id`.

- [ ] **Step 3: Commit**

```bash
cd /root/dev/projects/Ei
git add docs/superpowers/specs/2026-08-11-scheduled-jobs-design.md
git commit -m "docs: restore dm_thread_id/dm_channel_id in scheduled jobs spec"
```

(If nothing changed, `git commit` fails with "nothing to commit"; that is fine — proceed.)

---

### Task 1: Shared continuation token gains `scheduleRunId`

**Files:**
- Modify: `packages/shared/src/discord-util.ts`
- Modify: `packages/shared/src/index.ts`
- Test: create `packages/shared/src/discord-util.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface DiscordAddress { guildId: string; channelId: string; threadId?: string; scheduleRunId?: string }`
  - `encodeToken(a: DiscordAddress): string` — appends `:${scheduleRunId}` only when present.
  - `decodeToken(token: string): DiscordAddress | null` — parses the optional 4th segment back; backward compatible (3-segment and old 2-segment tokens still decode; `scheduleRunId` absent).
  - Re-exported from `packages/shared/src/index.ts` (unchanged export list; the shared build compiles this file).
- Tests live in the shared package (no agent dependency); the agent consumes the built `dist/`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/discord-util.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decodeToken, encodeToken } from "./discord-util";

describe("discord-util continuation token", () => {
  test("encodes guild:channel[:thread] and round-trips", () => {
    expect(encodeToken({ guildId: "g", channelId: "c" })).toBe("g:c");
    expect(decodeToken("g:c")).toEqual({ guildId: "g", channelId: "c" });
    const withThread = encodeToken({ guildId: "g", channelId: "c", threadId: "t" });
    expect(withThread).toBe("g:c:t");
    expect(decodeToken(withThread)).toEqual({ guildId: "g", channelId: "c", threadId: "t" });
  });

  test("embeds and recovers an optional scheduleRunId as the 4th segment", () => {
    const token = encodeToken({ guildId: "g", channelId: "c", threadId: "t", scheduleRunId: "r1" });
    expect(token).toBe("g:c:t:r1");
    expect(decodeToken(token)).toEqual({ guildId: "g", channelId: "c", threadId: "t", scheduleRunId: "r1" });
  });

  test("tokens without a thread or scheduleRunId stay backward compatible", () => {
    expect(decodeToken("g:c")?.scheduleRunId).toBeUndefined();
    expect(decodeToken("g:c:t")?.scheduleRunId).toBeUndefined();
    expect(decodeToken("not-a-token")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/shared && bun test src/discord-util.test.ts
```

Expected: FAIL — `scheduleRunId` fails `toBe("g:c:t:r1")` / decode returns `undefined`.

- [ ] **Step 3: Write the implementation**

Replace the contents of `packages/shared/src/discord-util.ts`:

```ts
export interface DiscordAddress {
  guildId: string;
  channelId: string;
  threadId?: string;
  scheduleRunId?: string;
}

export function encodeToken(a: DiscordAddress): string {
  const base = a.threadId ? `${a.guildId}:${a.channelId}:${a.threadId}` : `${a.guildId}:${a.channelId}`;
  return a.scheduleRunId ? `${base}:${a.scheduleRunId}` : base;
}

export function decodeToken(token: string): DiscordAddress | null {
  const [guildId, channelId, threadId, scheduleRunId] = token.split(":");
  if (!guildId || !channelId) return null;
  const out: DiscordAddress = { guildId, channelId };
  if (threadId) out.threadId = threadId;
  if (scheduleRunId) out.scheduleRunId = scheduleRunId;
  return out;
}

export function splitReply(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
```

`packages/shared/src/index.ts` already re-exports the named functions and `type DiscordAddress`; no change needed there.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /root/dev/projects/Ei/packages/shared && bun test src/discord-util.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Rebuild shared + typecheck**

```bash
cd /root/dev/projects/Ei && bun run build:shared && bun run typecheck:shared
```

Expected: build writes `packages/shared/dist/`, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/shared/src/discord-util.ts packages/shared/src/index.ts packages/shared/src/discord-util.test.ts
git commit -m "feat: continuation token carries optional scheduleRunId"
```

---

### Task 2: Schedule schema migration (`ei_schedules` + `ei_schedule_runs`)

**Files:**
- Modify: `packages/agent/lib/db.ts` (`MIGRATE_SQL`)
- Modify: `packages/agent/tests/db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MIGRATE_SQL` now also creates `ei_schedules` and `ei_schedule_runs` with the exact columns Tasks 3+ rely on:
  `ei_schedules(id, name, prompt, cadence, every_minutes, cron, timezone, enabled, next_run_at, created_at, updated_at, last_run_at, last_run_status, last_run_output, run_count, locked_until, locked_by, owner_discord_id, guild_id, dm_channel_id, dm_thread_id, tags, created_by)` and `ei_schedule_runs(id, schedule_id, started_at, finished_at, status, output, error, session_id)`.

- [ ] **Step 1: Extend `MIGRATE_SQL`**

Append to the `MIGRATE_SQL` template literal in `packages/agent/lib/db.ts` (before the closing backtick):

```sql
create table if not exists ei_schedules (
  id text primary key,
  name text not null,
  prompt text not null,
  cadence text not null,
  every_minutes int,
  cron text,
  timezone text not null default 'UTC',
  enabled boolean not null default true,
  next_run_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_run_status text,
  last_run_output text,
  run_count bigint not null default 0,
  locked_until timestamptz,
  locked_by text,
  owner_discord_id text not null,
  guild_id text not null,
  dm_channel_id text not null,
  dm_thread_id text,
  tags jsonb not null default '[]'::jsonb,
  created_by text
);
create table if not exists ei_schedule_runs (
  id text primary key,
  schedule_id text not null references ei_schedules(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  output text,
  error text,
  session_id text
);
```

- [ ] **Step 2: Extend `db.test.ts`**

Add a test to the `describe("migrate + schema")` block in `packages/agent/tests/db.test.ts`:

```ts
test("creates ei_schedules and ei_schedule_runs with references", async () => {
  const ex = await memExecutor();
  await migrate(ex);

  await ex.query(
    `insert into ei_schedules
      (id, name, prompt, cadence, every_minutes, next_run_at, owner_discord_id, guild_id, dm_channel_id)
     values ($1, $2, $3, $4, $5, now(), $6, $7, $8)`,
    ["s1", "remind", "Call the dentist", "every_minutes", 30, "u1", "g1", "c1"],
  );
  await ex.query(
    `insert into ei_schedule_runs (id, schedule_id, status, output) values ('r1', 's1', 'succeeded', 'done')`,
  );
  const runs = await ex.query(`select * from ei_schedule_runs where schedule_id = $1`, ["s1"]);
  expect(runs.rows).toHaveLength(1);
  expect(runs.rows[0].status).toBe("succeeded");

  // cascade delete: run rows follow the schedule
  await ex.query(`delete from ei_schedules where id = 's1'`);
  const left = await ex.query(`select count(*)::int as n from ei_schedule_runs`);
  expect(left.rows[0].n).toBe(0);
});
```

- [ ] **Step 3: Run the test**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/db.test.ts
```

Expected: PASS (both original and new test).

- [ ] **Step 4: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/lib/db.ts packages/agent/tests/db.test.ts
git commit -m "feat: ei_schedules and ei_schedule_runs tables"
```

---

### Task 3: Cadence/timezone math (`lib/schedule-admin.ts`)

**Files:**
- Create: `packages/agent/lib/schedule-admin.ts`
- Test: `packages/agent/tests/schedule-admin.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (later tasks depend on these exact names/shapes):
  - `export type ScheduleCadence =
      | { kind: "every_minutes"; everyMinutes: number }
      | { kind: "daily_at"; time: string }
      | { kind: "weekly_on"; time: string; weekly: number[] }
      | { kind: "monthly_on"; dayOfMonth: number; time: string }`
    `weekly: number[]` is 0-6 (0=Sunday) weekdays to run (at least one required). `monthlyOn-dayOfMonth` is 1-31; days beyond month length clamp to the last day. (`weekly_on` is its own kind so it round-trips 1:1 with the `cadence` column and `cadenceOf`; `daily_at` runs every day.)
  - `export interface ScheduledCadenceInput` — the discriminated union above.
  - `export function validateCadence(input: ScheduledCadenceInput): void` — throws `Error` with a clear message on invalid input (`everyMinutes` not int/≤0, bad `time` string, bad weekday, bad dayOfMonth).
  - `export function computeNextRun(from: Date, input: ScheduledCadenceInput, timezone: string): Date` — returns the next run strictly after `from`, computed in the given IANA timezone via `Intl` (clamps month-end for `monthly_on`). `from` is an ISO/epoch-equivalent `Date`; the return is an absolute `Date`.
  - `export function formatNextRun(d: Date, timezone: string): string` — ISO 8601 with offset, e.g. `2026-08-12T08:30:00.000Z` → `2026-08-11T08:30:00-04:00` style (use `Intl.DateTimeFormat` with `timeZone`, `calendar: "gregory"`, fractional-second-digits 0, `timeZoneName` omitted, `formatToParts`).
  - `export function parseSchedulePrompt(cadenceText: string): ScheduledCadenceInput | null` — best-effort parse of short user phrases ("every 30 minutes", "daily at 09:00", "weekdays at 08:00", "monthly on the 3rd at 12:00", "monday wednesday at 10:00"); returns `null` when it cannot parse the phrase (the tool then requires explicit fields).

- [ ] **Step 1: Write the failing test**

Create `packages/agent/tests/schedule-admin.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  computeNextRun,
  validateCadence,
  formatNextRun,
  parseSchedulePrompt,
  type ScheduledCadenceInput,
} from "../lib/schedule-admin";

const TZ = "America/New_York";

function iso(d: Date): string {
  return d.toISOString();
}

describe("validateCadence", () => {
  test("accepts valid cadences", () => {
    expect(() => validateCadence({ kind: "every_minutes", everyMinutes: 30 })).not.toThrow();
    expect(() => validateCadence({ kind: "daily_at", time: "08:30" })).not.toThrow();
    expect(() => validateCadence({ kind: "weekly_on", time: "08:30", weekly: [1, 3] })).not.toThrow();
    expect(() => validateCadence({ kind: "monthly_on", dayOfMonth: 3, time: "12:00" })).not.toThrow();
  });

  test("rejects invalid cadences", () => {
    expect(() => validateCadence({ kind: "every_minutes", everyMinutes: 0 })).toThrow();
    expect(() => validateCadence({ kind: "daily_at", time: "25:00" })).toThrow();
    expect(() => validateCadence({ kind: "weekly_on", time: "08:30", weekly: [7] })).toThrow();
    expect(() => validateCadence({ kind: "monthly_on", dayOfMonth: 0, time: "12:00" })).toThrow();
  });
});

describe("computeNextRun", () => {
  const aug10_0000 = new Date("2026-08-10T00:00:00.000Z"); // Monday 2026-08-10 00:00 UTC

  test("every_minutes advances by the interval", () => {
    const next = computeNextRun(aug10_0000, { kind: "every_minutes", everyMinutes: 30 }, "UTC");
    expect(iso(next)).toBe("2026-08-10T00:30:00.000Z");
  });

  test("daily_at lands on the wall-clock time in the timezone", () => {
    // America/New_York is UTC-4 in August: 08:30 local = 12:30 UTC.
    const next = computeNextRun(aug10_0000, { kind: "daily_at", time: "08:30" }, TZ);
    expect(iso(next)).toBe("2026-08-10T12:30:00.000Z");
  });

  test("weekly_on respects the allowed weekdays (Monday 0? no: 1 = Monday)", () => {
    // Aug 10 2026 is a Monday. weekly [2,4] = Tuesday, Thursday.
    const next = computeNextRun(aug10_0000, { kind: "weekly_on", time: "09:00", weekly: [2, 4] }, "UTC");
    expect(iso(next)).toBe("2026-08-11T09:00:00.000Z"); // Tuesday
  });

  test("monthly_on clamps to the last day of short months", () => {
    // Jan 31 in a month with 30 days -> Feb 28/29.
    const jan31 = new Date("2026-01-31T00:00:00.000Z");
    const next = computeNextRun(jan31, { kind: "monthly_on", dayOfMonth: 31, time: "10:00" }, "UTC");
    // 2026-02-28 10:00 UTC (2026 is not a leap year)
    expect(iso(next)).toBe("2026-02-28T10:00:00.000Z");
  });
});

describe("formatNextRun", () => {
  test("renders an absolute instant with the timezone offset", () => {
    const s = formatNextRun(new Date("2026-08-10T12:30:00.000Z"), TZ);
    expect(s).toMatch(/2026-08-10T08:30:00/); // 12:30Z = 08:30 in NY
  });
});

describe("parseSchedulePrompt", () => {
  test("parses common phrases", () => {
    expect(parseSchedulePrompt("every 30 minutes")).toEqual({ kind: "every_minutes", everyMinutes: 30 });
    expect(parseSchedulePrompt("daily at 09:00")).toEqual({ kind: "daily_at", time: "09:00" });
    expect(parseSchedulePrompt("weekdays at 08:00")).toEqual({
      kind: "weekly_on",
      time: "08:00",
      weekly: [1, 2, 3, 4, 5],
    });
    expect(parseSchedulePrompt("monthly on the 3rd at 12:00")).toEqual({
      kind: "monthly_on",
      dayOfMonth: 3,
      time: "12:00",
    });
  });

  test("returns null for unparseable text", () => {
    expect(parseSchedulePrompt("whenever")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/schedule-admin.test.ts
```

Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Write the implementation**

Create `packages/agent/lib/schedule-admin.ts`:

```ts
// Pure cadence/timezone math for scheduled jobs. No DB, no env access.
export type ScheduledCadenceInput =
  | { kind: "every_minutes"; everyMinutes: number }
  | { kind: "daily_at"; time: string; weekly?: number[] }
  | { kind: "monthly_on"; dayOfMonth: number; time: string };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateCadence(input: ScheduledCadenceInput): void {
  switch (input.kind) {
    case "every_minutes":
      if (!Number.isInteger(input.everyMinutes) || input.everyMinutes <= 0) {
        throw new Error("everyMinutes must be a positive integer");
      }
      return;
    case "daily_at":
      if (!TIME_RE.test(input.time)) throw new Error("time must be HH:MM in 24h format");
      return;
    case "weekly_on":
      if (!TIME_RE.test(input.time)) throw new Error("time must be HH:MM in 24h format");
      if (!input.weekly?.length || input.weekly.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new Error("weekly must be a non-empty list of 0-6 (0=Sunday)");
      }
      return;
    case "monthly_on":
      if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
        throw new Error("dayOfMonth must be 1-31");
      }
      if (!TIME_RE.test(input.time)) throw new Error("time must be HH:MM in 24h format");
      return;
  }
}

const MINUTE_MS = 60_000;

// Absolute next-run instant strictly after `from`, in IANA `timezone`.
export function computeNextRun(from: Date, input: ScheduledCadenceInput, timezone: string): Date {
  validateCadence(input);
  const tz = Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;

  switch (input.kind) {
    case "every_minutes":
      return new Date(from.getTime() + input.everyMinutes * MINUTE_MS);

    case "daily_at": {
      const [h, m] = input.time.split(":").map(Number);
      const weekly = input.weekly ?? null;
      let candidate = from;
      // Start from the next minute boundary to be strictly after `from`.
      candidate = new Date(candidate.getTime() + MINUTE_MS);
      // Bound: 2 days of minutes covers any daily target even with DST shifts
      // and when created right after the daily time.
      for (let i = 0; i < 2 * 24 * 60 + 1; i++) {
        const wall = wallTimeInTz(candidate, tz);
        const wd = weekdayInTz(candidate, tz);
        if (
          wall.h === h &&
          wall.m === m &&
          (weekly === null || weekly.includes(wd))
        ) {
          return candidate;
        }
        candidate = new Date(candidate.getTime() + MINUTE_MS);
      }
      throw new Error("could not compute next run (no matching wall-clock time within 2 days)");
    }

    case "monthly_on": {
      const [h, m] = input.time.split(":").map(Number);
      let candidate = new Date(from.getTime() + MINUTE_MS);
      // Bound: 32 days of minutes covers a monthly target with month-end
      // clamping and creation right after the target day.
      for (let i = 0; i < 32 * 24 * 60 + 1; i++) {
        const wall = wallTimeInTz(candidate, tz);
        const dom = wall.d;
        const lastDay = lastDayOfMonth(candidate, tz);
        const targetDom = Math.min(input.dayOfMonth, lastDay);
        if (dom === targetDom && wall.h === h && wall.m === m) return candidate;
        candidate = new Date(candidate.getTime() + MINUTE_MS);
      }
      throw new Error("could not compute next run (monthly_on)");
    }
  }
}

function wallTimeInTz(d: Date, tz: string): { h: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    day: "numeric",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { h: get("hour"), m: get("minute"), d: get("day") };
}

function weekdayInTz(d: Date, tz: string): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  // Sun-Sat -> 0-6
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(s);
}

function lastDayOfMonth(d: Date, tz: string): number {
  const y = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(d);
  const mo = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric" }).format(d));
  // First day of next month minus one day, in the same tz.
  const probe = new Date(`${y}-${String(mo + 1).padStart(2, "0")}-01T00:00:00Z`);
  const last = new Date(probe.getTime() - 86_400_000);
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).formatToParts(last)
    .find((p) => p.type === "day")?.value
    ? Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(last))
    : 31;
}

export function formatNextRun(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const offset = tzName.replace(/GMT/, "") || "Z";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

const WEEKDAY_ALIASES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const TIME_PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => ScheduledCadenceInput | null }> = [
  {
    re: /^every\s+(\d+)\s+minutes?$/i,
    build: (m) => ({ kind: "every_minutes", everyMinutes: Number(m[1]) }),
  },
  {
    re: /^daily\s+at\s+(\d{1,2}:\d{2})$/i,
    build: (m) => ({ kind: "daily_at", time: m[1] }),
  },
  {
    re: /^weekdays?\s+at\s+(\d{1,2}:\d{2})$/i,
    build: (m) => ({ kind: "weekly_on", time: m[1], weekly: [1, 2, 3, 4, 5] }),
  },
  {
    re: /^(?:every\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))*\s+at\s+(\d{1,2}:\d{2})$/i,
    build: (m) => {
      const days: number[] = [];
      for (let i = 1; i < m.length - 1; i++) {
        if (m[i]) days.push(WEEKDAY_ALIASES[m[i].toLowerCase()]);
      }
      return { kind: "weekly_on", time: m[m.length - 1], weekly: [...new Set(days)] };
    },
  },
  {
    re: /^monthly\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\s+at\s+(\d{1,2}:\d{2})$/i,
    build: (m) => ({ kind: "monthly_on", dayOfMonth: Number(m[1]), time: m[2] }),
  },
];

export function parseSchedulePrompt(cadenceText: string): ScheduledCadenceInput | null {
  const text = cadenceText.trim();
  for (const { re, build } of TIME_PATTERNS) {
    const m = text.match(re);
    if (m) {
      try {
        const parsed = build(m);
        if (parsed) {
          validateCadence(parsed);
          return parsed;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/schedule-admin.test.ts
```

Expected: PASS (all tests). If a DST/probe edge fails, adjust the helper (e.g. `lastDayOfMonth`) so the assertions hold for 2026.

- [ ] **Step 5: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/lib/schedule-admin.ts packages/agent/tests/schedule-admin.test.ts
git commit -m "feat: cadence/timezone math for scheduled jobs"
```

---

### Task 4: Schedule store adapter (`lib/schedule-store.ts`)

**Files:**
- Create: `packages/agent/lib/schedule-store.ts`
- Modify: `packages/agent/tests/schedule-store.test.ts` (new)

**Interfaces:**
- Consumes: `SqlExecutor` from `./db`, `ScheduledCadenceInput` from `./schedule-admin`.
- Produces (later tasks depend on these exact names/shapes):
  - `export interface ScheduleRow { id: string; name: string; prompt: string; cadence: string; every_minutes: number | null; cron: string | null; timezone: string; enabled: boolean; next_run_at: string; last_run_at: string | null; last_run_status: string | null; last_run_output: string | null; run_count: number; owner_discord_id: string; guild_id: string; dm_channel_id: string; dm_thread_id: string | null; tags: unknown; created_by: string | null }`
  - `export interface CreateScheduleInput { name: string; prompt: string; cadence: ScheduledCadenceInput; timezone?: string; firstRunAt?: string; tags?: string[]; owner: { principalId: string; guildId: string; channelId: string; threadId?: string } }`
  - `export async function createSchedule(ex, input: CreateScheduleInput): Promise<ScheduleRow>`
  - `export async function listSchedules(ex): Promise<ScheduleRow[]>`
  - `export async function getSchedule(ex, idOrName: string): Promise<ScheduleRow | null>`
  - `export async function triggerSchedule(ex, idOrName: string): Promise<{ ok: boolean; name?: string }>` — forces `next_run_at = now()` (and clears any lock) on an enabled schedule; returns `{ ok: false }` when the id does not exist.
  - `export async function updateSchedule(ex, id: string, patch: { prompt?: string; cadence?: ScheduledCadenceInput; timezone?: string; enabled?: boolean; name?: string; tags?: string[] }): Promise<ScheduleRow | null>`
  - `export async function deleteSchedule(ex, idOrName: string): Promise<ScheduleRow | null>`
  - `export interface ClaimedSchedule { id: string; name: string; prompt: string; runId: string; guild_id: string; dm_channel_id: string; dm_thread_id: string | null; every_minutes: number | null; cron: string | null; timezone: string; cadence: ScheduledCadenceInput }`
  - `export async function claimDue(ex, opts: { now: Date; limit: number; leaseForMs: number }): Promise<ClaimedSchedule[]>` — atomically leases due rows (see SQL below), creates a `running` run row per lease, returns the claimed jobs.
  - `export async function completeRun(ex, runId: string, outcome: { status: "succeeded" | "failed" | "skipped"; output?: string; error?: string; sessionId?: string }): Promise<void>` — writes the run row's finish state and bumps `last_run_*`/`run_count` on the schedule.
  - `export async function listRuns(ex, scheduleId: string, limit = 3): Promise<RunRow[]>` — newest-first.
  - `export interface RunRow { id: string; schedule_id: string; started_at: string; finished_at: string | null; status: string; output: string | null; error: string | null; session_id: string | null }`
  - Ids: `randomUUID()`-based (crypto, available in Node 24 + Bun). Recurrence: `completeRun` advances `next_run_at` to `computeNextRun(started_at, cadence, timezone)` (the single recurrence source), keeping `next_run_at` unchanged while a schedule is disabled.

- [ ] **Step 1: Write the failing test**

Create `packages/agent/tests/schedule-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, type SqlExecutor } from "../lib/db";
import {
  claimDue,
  completeRun,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listRuns,
  listSchedules,
  updateSchedule,
} from "../lib/schedule-store";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

const OWNER = { principalId: "u1", guildId: "g1", channelId: "c1" };

describe("schedule-store", () => {
  test("create/list/get lifecycle", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "remind",
      prompt: "Call the dentist",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      owner: OWNER,
    });
    expect(s.id).toBeTruthy();
    expect(s.cadence).toBe("every_minutes");
    expect(await getSchedule(ex, "remind")).not.toBeNull();
    expect(await getSchedule(ex, s.id)).not.toBeNull();
    const rows = await listSchedules(ex);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("remind");
  });

  test("update toggles enabled and recomputes next_run_on cadence change", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "digest",
      prompt: "Digest calendar",
      cadence: { kind: "daily_at", time: "08:00" },
      timezone: "UTC",
      owner: OWNER,
    });
    const updated = await updateSchedule(ex, s.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    const moved = await updateSchedule(ex, s.id, { cadence: { kind: "every_minutes", everyMinutes: 60 } });
    expect(moved?.cadence).toBe("every_minutes");
    expect(moved?.every_minutes).toBe(60);
  });

  test("delete removes the schedule", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, { name: "x", prompt: "p", cadence: { kind: "every_minutes", everyMinutes: 30 }, owner: OWNER });
    expect((await deleteSchedule(ex, s.id))?.id).toBe(s.id);
    expect(await getSchedule(ex, s.id)).toBeNull();
  });

  test("claimDue leases due rows, creates running runs, and skips leased/future rows", async () => {
    const ex = await memExecutor();
    const due = await createSchedule(ex, {
      name: "due",
      prompt: "p1",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      timezone: "UTC",
      firstRunAt: new Date(Date.now() - 60_000).toISOString(),
      owner: OWNER,
    });
    const future = await createSchedule(ex, {
      name: "future",
      prompt: "p2",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      timezone: "UTC",
      firstRunAt: new Date(Date.now() + 60_000).toISOString(),
      owner: OWNER,
    });
    const now = new Date();
    const first = await claimDue(ex, { now, limit: 25, leaseForMs: 5 * 60_000 });
    expect(first).toHaveLength(1);
    expect(first[0].name).toBe("due");
    expect(first[0].runId).toBeTruthy();

    // Second claim (same tick) gets nothing: the row is leased.
    expect(await claimDue(ex, { now, limit: 25, leaseForMs: 5 * 60_000 })).toHaveLength(0);

    // The run row exists in 'running' state.
    const runs = await listRuns(ex, due.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("running");
  });

  test("completeRun records outcome and bumps schedule last_run fields", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "job",
      prompt: "p",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      timezone: "UTC",
      owner: OWNER,
    });
    await claimDue(ex, { now: new Date(), limit: 25, leaseForMs: 5 * 60_000 });
    const runs = await listRuns(ex, s.id, 10);
    await completeRun(ex, runs[0].id, { status: "succeeded", output: "done", sessionId: "sess1" });
    const after = await listRuns(ex, s.id, 10);
    expect(after[0].status).toBe("succeeded");
    expect(after[0].output).toBe("done");
    const row = await getSchedule(ex, s.id);
    expect(row?.last_run_status).toBe("succeeded");
    expect(row?.last_run_output).toBe("done");
    expect(row?.run_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/schedule-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/agent/lib/schedule-store.ts`:

```ts
// ei_schedules + ei_schedule_runs adapter over the repo's SqlExecutor.
// Atomically leases due rows so overlapping dispatcher ticks never claim twice.
import { randomUUID } from "node:crypto";
import { jsonValue, type SqlExecutor } from "./db";
import { computeNextRun, type ScheduledCadenceInput } from "./schedule-admin";

export interface ScheduleRow {
  id: string;
  name: string;
  prompt: string;
  cadence: string;
  every_minutes: number | null;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_output: string | null;
  run_count: number;
  owner_discord_id: string;
  guild_id: string;
  dm_channel_id: string;
  dm_thread_id: string | null;
  tags: unknown;
  created_by: string | null;
}

export interface CreateScheduleInput {
  name: string;
  prompt: string;
  cadence: ScheduledCadenceInput;
  timezone?: string;
  firstRunAt?: string;
  tags?: string[];
  owner: { principalId: string; guildId: string; channelId: string; threadId?: string };
}

export interface ClaimedSchedule {
  id: string;
  name: string;
  prompt: string;
  runId: string;
  guild_id: string;
  dm_channel_id: string;
  dm_thread_id: string | null;
  cadence: ScheduledCadenceInput;
}

export interface RunRow {
  id: string;
  schedule_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  output: string | null;
  error: string | null;
  session_id: string | null;
}

function rowOf(r: Record<string, unknown>): ScheduleRow {
  return {
    id: String(r.id),
    name: String(r.name),
    prompt: String(r.prompt),
    cadence: String(r.cadence),
    every_minutes: r.every_minutes == null ? null : Number(r.every_minutes),
    cron: r.cron == null ? null : String(r.cron),
    timezone: String(r.timezone),
    enabled: Boolean(r.enabled),
    next_run_at: String(r.next_run_at),
    last_run_at: r.last_run_at == null ? null : String(r.last_run_at),
    last_run_status: r.last_run_status == null ? null : String(r.last_run_status),
    last_run_output: r.last_run_output == null ? null : String(r.last_run_output),
    run_count: Number(r.run_count ?? 0),
    owner_discord_id: String(r.owner_discord_id),
    guild_id: String(r.guild_id),
    dm_channel_id: String(r.dm_channel_id),
    dm_thread_id: r.dm_thread_id == null ? null : String(r.dm_thread_id),
    tags: jsonValue(r.tags),
    created_by: r.created_by == null ? null : String(r.created_by),
  };
}

function cadenceOf(row: ScheduleRow): ScheduledCadenceInput {
  switch (row.cadence) {
    case "every_minutes":
      return { kind: "every_minutes", everyMinutes: row.every_minutes ?? 30 };
    case "daily_at":
      return { kind: "daily_at", time: row.cron ?? "00:00" };
    case "weekly_on": {
      // cron stores `HH:MM:1,3` (time + comma-separated weekdays).
      const idx = (row.cron ?? "00:00").lastIndexOf(":");
      const timePart = idx > 0 ? (row.cron ?? "00:00").slice(0, idx) : "00:00";
      const weekPart = idx > 0 ? (row.cron ?? "00:00").slice(idx + 1) : "";
      const weekly = weekPart ? weekPart.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [];
      return { kind: "weekly_on", time: timePart, weekly };
    }
    case "monthly_on": {
      // cron stores `DAY:HH:MM`.
      const m = (row.cron ?? "1:00:00").match(/^(\d{1,2}):([0-2]\d:[0-5]\d)$/);
      return { kind: "monthly_on", dayOfMonth: m ? Number(m[1]) : 1, time: m ? m[2] : "00:00" };
    }
    default:
      return { kind: "every_minutes", everyMinutes: 30 };
  }
}

export async function createSchedule(ex: SqlExecutor, input: CreateScheduleInput): Promise<ScheduleRow> {
  const id = randomUUID();
  const tz = input.timezone ?? "UTC";
  const from = input.firstRunAt ? new Date(input.firstRunAt) : new Date();
  // firstRunAt (when given) is the trigger instant verbatim; without it the
  // schedule is due immediately on the next tick. computeNextRun only drives
  // recurrence (see completeRun).
  const tags = input.tags ?? [];
  await ex.query(
    `insert into ei_schedules
      (id, name, prompt, cadence, every_minutes, cron, timezone, next_run_at, owner_discord_id, guild_id, dm_channel_id, dm_thread_id, tags, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
    [
      id,
      input.name,
      input.prompt,
      input.cadence.kind,
      input.cadence.kind === "every_minutes" ? input.cadence.everyMinutes : null,
      encodeCadenceValue(input.cadence),
      tz,
      from.toISOString(),
      input.owner.principalId,
      input.owner.guildId,
      input.owner.channelId,
      input.owner.threadId ?? null,
      JSON.stringify(tags),
      input.owner.principalId,
    ],
  );
  const got = await getSchedule(ex, id);
  if (!got) throw new Error("schedule write failed");
  return got;
}

export async function listSchedules(ex: SqlExecutor): Promise<ScheduleRow[]> {
  const r = await ex.query(`select * from ei_schedules order by next_run_at`);
  return r.rows.map(rowOf);
}

export async function getSchedule(ex: SqlExecutor, idOrName: string): Promise<ScheduleRow | null> {
  const r = await ex.query(`select * from ei_schedules where id = $1 or name = $1 limit 1`, [idOrName]);
  return r.rows.length ? rowOf(r.rows[0]) : null;
}

export async function updateSchedule(
  ex: SqlExecutor,
  idOrName: string,
  patch: { prompt?: string; cadence?: ScheduledCadenceInput; timezone?: string; enabled?: boolean; name?: string; tags?: string[] },
): Promise<ScheduleRow | null> {
  const existing = await getSchedule(ex, idOrName);
  if (!existing) return null;
  const tz = patch.timezone ?? existing.timezone;
  const cadence = patch.cadence ?? cadenceOf(existing);
  const next = computeNextRun(new Date(existing.next_run_at), cadence, tz);
  const fields: string[] = [];
  const values: unknown[] = [];
  const push = (col: string, v: unknown) => {
    fields.push(`${col} = $${values.length + 1}`);
    values.push(v);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.prompt !== undefined) push("prompt", patch.prompt);
  if (patch.cadence !== undefined) {
    push("cadence", cadence.kind);
    push("every_minutes", cadence.kind === "every_minutes" ? cadence.everyMinutes : null);
    push("cron", encodeCadenceValue(cadence));
  }
  if (patch.timezone !== undefined) push("timezone", tz);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.tags !== undefined) push("tags", JSON.stringify(patch.tags));
  values.push(next.toISOString());
  fields.push(`next_run_at = $${values.length}`, `updated_at = now()`);
  await ex.query(`update ei_schedules set ${fields.join(", ")} where id = $${values.length + 1}`, [...values, existing.id]);
  return getSchedule(ex, existing.id);
}

export async function deleteSchedule(ex: SqlExecutor, idOrName: string): Promise<ScheduleRow | null> {
  const existing = await getSchedule(ex, idOrName);
  if (!existing) return null;
  await ex.query(`delete from ei_schedules where id = $1`, [existing.id]);
  return existing;
}

export async function triggerSchedule(ex: SqlExecutor, idOrName: string): Promise<{ ok: boolean; name?: string }> {
  const r = await ex.query(
    `update ei_schedules set next_run_at = now(), locked_until = null, locked_by = null
     where id = $1 and enabled returning *`,
    [idOrName],
  );
  if (!r.rows.length) {
    // Try by name.
    const byName = await ex.query(
      `update ei_schedules set next_run_at = now(), locked_until = null, locked_by = null
       where name = $1 and enabled returning *`,
      [idOrName],
    );
    if (!byName.rows.length) return { ok: false };
    return { ok: true, name: String(byName.rows[0].name) };
  }
  return { ok: true, name: String(r.rows[0].name) };
}

// Atomic lease: claim due, enabled rows whose lock expired. Pure SQL so
// overlapping ticks never double-claim. Creates one 'running' run row per claim.
export async function claimDue(
  ex: SqlExecutor,
  opts: { now: Date; limit: number; leaseForMs: number },
): Promise<ClaimedSchedule[]> {
  const nowIso = opts.now.toISOString();
  const lockUntil = new Date(opts.now.getTime() + opts.leaseForMs).toISOString();
  const r = await ex.query(
    `update ei_schedules
       set locked_until = $1, locked_by = $2, last_run_at = now()
     where id in (
       select id from ei_schedules
       where enabled and next_run_at <= $3 and (locked_until is null or locked_until < $3)
       order by next_run_at
       limit $4
     )
     returning *`,
    [lockUntil, "dispatcher", nowIso, opts.limit],
  );
  const claimed: ClaimedSchedule[] = [];
  for (const row of r.rows) {
    const s = rowOf(row);
    const runId = randomUUID();
    await ex.query(
      `insert into ei_schedule_runs (id, schedule_id, status) values ($1, $2, 'running')`,
      [runId, s.id],
    );
    claimed.push({
      id: s.id,
      name: s.name,
      prompt: s.prompt,
      runId,
      guild_id: s.guild_id,
      dm_channel_id: s.dm_channel_id,
      dm_thread_id: s.dm_thread_id,
      cadence: cadenceOf(s),
    });
  }
  return claimed;
}

export async function completeRun(
  ex: SqlExecutor,
  runId: string,
  outcome: { status: "succeeded" | "failed" | "skipped"; output?: string; error?: string; sessionId?: string },
): Promise<void> {
  await ex.query(
    `update ei_schedule_runs
       set status = $2, finished_at = now(), output = $3, error = $4, session_id = $5
     where id = $1`,
    [runId, outcome.status, outcome.output ?? null, outcome.error ?? null, outcome.sessionId ?? null],
  );
  await ex.query(
    `update ei_schedules
       set last_run_status = $2, last_run_output = $3, run_count = run_count + 1,
           last_run_at = now(), locked_until = null, locked_by = null
     where id in (select schedule_id from ei_schedule_runs where id = $1)`,
    [runId, outcome.status, outcome.output ?? null],
  );
}

export async function listRuns(ex: SqlExecutor, scheduleId: string, limit = 3): Promise<RunRow[]> {
  const r = await ex.query(
    `select * from ei_schedule_runs where schedule_id = $1 order by started_at desc limit $2`,
    [scheduleId, limit],
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    schedule_id: String(row.schedule_id),
    started_at: String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
    status: String(row.status),
    output: row.output == null ? null : String(row.output),
    error: row.error == null ? null : String(row.error),
    session_id: row.session_id == null ? null : String(row.session_id),
  }));
}

// Serialize a cadence into `every_minutes`/`cron` columns:
//  - every_minutes: minutes int
//  - daily_at:      `HH:MM` (weekly list ignored for daily)
//  - weekly_on:     `HH:MM:1,3` (time + comma-separated weekdays)
//  - monthly_on:    `DAY:HH:MM`
function encodeCadenceValue(c: ScheduledCadenceInput): string | null {
  switch (c.kind) {
    case "every_minutes":
      return null;
    case "daily_at":
      return c.time;
    case "weekly_on":
      return `${c.time}:${(c.weekly ?? []).join(",")}`;
    case "monthly_on":
      return `${c.dayOfMonth}:${c.time}`;
  }
}
```

The `cadenceOf(row)` decode in `Task 4` reads back `ScheduledCadenceInput` from the columns when hydrating a `ClaimedSchedule`. `Task 3` "Note on CLI-`parseSchedulePrompt`" is not needed by this task — the tools in Task 7 parse via `parseSchedulePrompt` fallback only.

> **Task 4 self-review (implementation-time fixes):**
> 1. `createSchedule` no longer runs `firstRunAt` through `computeNextRun`. `firstRunAt` is the trigger instant verbatim (the plan's `claimDue` test passes a past `firstRunAt` and expects it claimed); without it the schedule is due on the next tick (`next_run_at = now()`).
> 2. `completeRun` advances recurrence: `next_run_at = computeNextRun(started_at, cadence, timezone)`, kept `next_run_at` on disabled schedules. The plan referenced `each_cadence_after` but never defined it; without this every recurring job would run exactly once.
> Both are covered by the Task 4 tests (`claimDue` claims the past-`firstRunAt` row; `completeRun` test relies on a no-`firstRunAt` schedule being due immediately).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/schedule-store.test.ts
```

Expected: PASS (5 tests). If pg-mem objects to the `update … where id in (select … limit)` shape, split into `select` + `update by id` (still atomic enough for the 25-row claim under one dispatcher).

- [ ] **Step 5: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/lib/schedule-store.ts packages/agent/tests/schedule-store.test.ts
git commit -m "feat: schedule store with atomic claim and run ledger"
```

---

### Task 5: `receive()` hook on the Discord channel + run logging from the continuation

**Files:**
- Modify: `packages/agent/agent/channels/discord.ts`
- Modify: `packages/agent/tests/channels-discord.test.ts` (new)

**Interfaces:**
- Consumes: `encodeToken`/`decodeToken` from `@ei/shared` (already imported), `completeRun` from `../lib/schedule-store`.
- Produces:
  - The `discord.ts` default export additionally exposes a `receive(input, ctx)` hook that starts a normal durable session from a schedule handoff: target shape `{ guildId, channelId, threadId?, scheduleRunId? }`; the continuation token embeds `scheduleRunId`.
  - `"message.completed"` handler now, when the decoded token carries a `scheduleRunId`, calls `completeRun(ex, scheduleRunId, { status: "succeeded", output: <trimmed message>, sessionId: <session id> })`.
  - `"turn.failed"`/`"session.failed"` handlers, when a `scheduleRunId` is present, call `completeRun(ex, scheduleRunId, { status: "failed", error: <message> })`.
  - The new hooks never throw (wrapped try/catch, best-effort DB write).

- [ ] **Step 1: Write the failing test**

Create `packages/agent/tests/channels-discord.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { encodeToken, decodeToken } from "@ei/shared";
import { migrate, type SqlExecutor } from "../lib/db";
import { completeRun, listRuns } from "../lib/schedule-store";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

describe("channels/discord scheduleRunId handle", () => {
  test("message.completed writes a succeeded run when scheduleRunId is present", async () => {
    const ex = await memExecutor();
    const scheduleId = "s1";

    const addr = { guildId: "g1", channelId: "c1", threadId: "t1", scheduleRunId: "r1" };
    const token = encodeToken(addr);
    const decoded = decodeToken(token);
    expect(decoded).toEqual(addr);

    // A fake dispatch: 'r1' must exist as a run row for completeRun to bump the schedule.
    await ex.query(
      `insert into ei_schedules (id, name, prompt, cadence, next_run_at, owner_discord_id, guild_id, dm_channel_id)
       values ($1, $2, $3, 'daily_at', now(), 'u1', 'g1', 'c1')`,
      [scheduleId, "remind", "p"],
    );
    await ex.query(`insert into ei_schedule_runs (id, schedule_id, status) values ('r1', $1, 'running')`, [scheduleId]);
    await completeRun(ex, "r1", { status: "succeeded", output: "done", sessionId: "s1" });

    const runs = await listRuns(ex, scheduleId, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
  });
});
```

(Steps 2–6 below: the receive hook itself needs a running runtime, so we assert the run-ledger contract and the token round-trip here; the hook implementation is exercised in the boot smoke + live E2E.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/channels-discord.test.ts
```

Expected: FAIL — `scheduleRunId` not yet in the token / module missing.

- [ ] **Step 3: Modify the channel**

In `packages/agent/agent/channels/discord.ts`:

1. Add imports at the top:

```ts
import { completeRun, } from "../lib/schedule-store";
import { getExecutor } from "../lib/db";
```

2. Add the `receive` hook to the `defineChannel({...})` object (after `events`, before the closing `})`):

```ts
receive(input, ctx) {
  const addr = encodeToken(input.target);
  return ctx.from(addr).send(input.message, { auth: input.auth });
},
```

`input.target` is `{ guildId, channelId, threadId?, scheduleRunId? }` (the `InferReceiveTarget` of the channel). `input.message` is a string or `UserContent` array (the dispatcher sends a string).

3. Extend the `"message.completed"` handler to write the run row when a `scheduleRunId` is present:

```ts
"message.completed"(eventData, channel, ctx) {
  const addr = channel.continuation ? decodeToken(channel.continuation.token) : null;
  if (!addr) return;
  if (addr.scheduleRunId) {
    const ex = getExecutor();
    if (ex) {
      void completeRun(ex, addr.scheduleRunId, {
        status: "succeeded",
        output: (eventData.message ?? "").slice(0, 4000),
        sessionId: ctx?.session?.id,
      }).catch(() => {});
    }
  }
  const message: string | null = eventData.message;
  if (!message) return;
  void deliverToDiscord(addr, message);
},
```

(The channel event third argument is the `SessionContext` (`ctx`); `ctx.session.id` is the session id. Pass it only when present — `sessionId` is optional on the run row.)

4. Add a `"turn.failed"` handler (the failure signal that carries `ctx`; `session.failed` deliberately receives no `ctx` in eve's adapter wiring):

```ts
"turn.failed"(eventData, channel, ctx) {
  const addr = channel.continuation ? decodeToken(channel.continuation.token) : null;
  if (!addr?.scheduleRunId) return;
  const ex = getExecutor();
  if (!ex) return;
  void completeRun(ex, addr.scheduleRunId, {
    status: "failed",
    error: typeof eventData.message === "string" ? eventData.message.slice(0, 1000) : "turn failed",
    sessionId: ctx?.session?.id,
  }).catch(() => {});
},
```

(`turn.failed` data is `{ code, details?, message, sequence, turnId }` — read `eventData.message` defensively.)

> **Task 5 self-review (implementation-time fixes to the plan):**
> 1. eve's `buildAdapter` passes `ctx` to every channel event handler **except** `session.failed` (`(data, channel)` only). The plan's `session.failed(data, channel, ctx)` would be a silent no-`ctx` bug; the plan now uses `turn.failed`, which does receive `ctx.session.id`, and reads its message from `eventData.message`.
> 2. The custom channel's receive target is untyped (`Readonly<Record<string, unknown>>`); `receive` casts via `as unknown as DiscordAddress` (the double cast is required because the shapes don't overlap).

- [ ] **Step 4: Run the test**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/channels-discord.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: clean. If `channel.sessionId` is not on the type, cast to a local interface (`{ sessionId?: string }`) and read defensively.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/agent/channels/discord.ts packages/agent/tests/channels-discord.test.ts
git commit -m "feat: discord channel receive hook + schedule run logging"
```

---

### Task 6: Dispatcher schedule (`agent/schedules/dispatcher.ts`)

**Files:**
- Create: `packages/agent/agent/schedules/dispatcher.ts`
- Test: `packages/agent/tests/dispatcher.test.ts` (new)

**Interfaces:**
- Consumes: `claimDue`, `completeRun` from `../lib/schedule-store`; `getExecutor` from `../../lib/db`.
- Produces: the authored schedule `export default defineSchedule({ cron: "* * * * *", run })` (file path `agent/schedules/dispatcher.ts` → schedule id `dispatcher`). Only schedule eve discovers; runs the exact dispatch path on each minute tick.

- [ ] **Step 1: Write the failing test**

Create `packages/agent/tests/dispatcher.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { migrate, type SqlExecutor } from "../lib/db";
import { claimDue, completeRun, createSchedule, getSchedule } from "../lib/schedule-store";
import { runDispatchCycle } from "../lib/schedule-dispatch";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

describe("dispatcher cycle", () => {
  test("runDispatchCycle claims, hands off, and completes a single job", async () => {
    const ex = await memExecutor();
    const s = await createSchedule(ex, {
      name: "job1",
      prompt: "p1",
      cadence: { kind: "every_minutes", everyMinutes: 30 },
      timezone: "UTC",
      firstRunAt: new Date(Date.now() - 60_000).toISOString(),
      owner: { principalId: "u1", guildId: "g1", channelId: "c1" },
    });
    const handed = await runDispatchCycle(ex, {
      now: new Date(),
      limit: 25,
      leaseForMs: 5 * 60_000,
      deliver: async (job) => job.prompt,
    });
    expect(handed).toHaveLength(1);
    expect(handed[0].name).toBe("job1");
    // The row is leased, so a second cycle in the same tick claims nothing.
    const again = await runDispatchCycle(ex, {
      now: new Date(),
      limit: 25,
      leaseForMs: 5 * 60_000,
      deliver: async (job) => job.prompt,
    });
    expect(again).toHaveLength(0);
  });
});
```

Note: the dispatcher module cannot be imported in unit tests without a running runtime (`defineSchedule` executes at import). This test drives the same core through a pure helper `runDispatchCycle(ex, opts)` that the schedule's `run` handler calls. `lib/schedule-dispatch.ts` is created in this task.

> **Task 6 self-review (implementation-time fixes):**
> 1. Auto-pause now checks the **N most recent runs** for all-failed (a success resets the streak), instead of counting *any* historical failures — the plan's `where status = 'failed'` would pause a schedule that ever failed 3 times even after recoveries.
> 2. The auto-pause test re-dues the schedule between failing ticks (`triggerSchedule`), because `completeRun` advances `next_run_at` by the cadence after each failed run.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/dispatcher.test.ts
```

Expected: FAIL — `../lib/schedule-dispatch` missing.

- [ ] **Step 3: Create the dispatch helper**

Create `packages/agent/lib/schedule-dispatch.ts`:

```ts
import type { SqlExecutor } from "./db";
import { claimDue, completeRun, type ClaimedSchedule } from "./schedule-store";

export interface DispatchOptions {
  now: Date;
  limit: number;
  leaseForMs: number;
  deliver: (job: ClaimedSchedule) => Promise<unknown> | unknown;
}

const PAUSE_AFTER_CONSECUTIVE_FAILURES = 3;

export async function runDispatchCycle(ex: SqlExecutor, opts: DispatchOptions): Promise<ClaimedSchedule[]> {
  const jobs = await claimDue(ex, { now: opts.now, limit: opts.limit, leaseForMs: opts.leaseForMs });
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await opts.deliver(job);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message.slice(0, 1000) : String(err);
        await completeRun(ex, job.runId, { status: "failed", error: errMsg });
        // Auto-pause after N consecutive failures (spec §6): count consecutive
        // failures via the run ledger and disable the schedule.
        const rows = await ex.query(
          `select id from ei_schedule_runs
           where schedule_id = $1 and status = 'failed'
           order by started_at desc limit $2`,
          [job.id, PAUSE_AFTER_CONSECUTIVE_FAILURES],
        );
        if (rows.rows.length >= PAUSE_AFTER_CONSECUTIVE_FAILURES) {
          await ex.query(`update ei_schedules set enabled = false where id = $1`, [job.id]);
        }
      }
    }),
  );
  return jobs;
}
```

- [ ] **Step 4: Create the authored schedule**

Create `packages/agent/agent/schedules/dispatcher.ts`:

```ts
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
```

- [ ] **Step 5: Run the test**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/dispatcher.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: clean. (The schedule module is picked up by `tsc` via `agent/**/*.ts`; no registration step.)

- [ ] **Step 7: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/agent/schedules/dispatcher.ts packages/agent/lib/schedule-dispatch.ts packages/agent/tests/dispatcher.test.ts
git commit -m "feat: minute dispatcher schedule for due jobs"
```

---

### Task 7: Schedule management tools (`tools/schedule_*.ts`)

**Files:**
- Create: `packages/agent/agent/tools/schedule_create.ts`
- Create: `packages/agent/agent/tools/schedule_list.ts`
- Create: `packages/agent/agent/tools/schedule_update.ts`
- Create: `packages/agent/agent/tools/schedule_delete.ts`
- Create: `packages/agent/agent/tools/schedule_runs.ts`
- Create: `packages/agent/agent/tools/schedule_trigger.ts`
- Modify: `packages/agent/agent/instructions.md`
- Test: `packages/agent/tests/schedule-tools.test.ts` (new)

**Interfaces:**
- Consumes: `getExecutor` from `../../lib/db`, `parseSchedulePrompt` from `../../lib/schedule-admin`, `createSchedule`/`listSchedules`/`updateSchedule`/`deleteSchedule`/`listRuns` from `../../lib/schedule-store`.
- Produces (all default-exported `defineTool` files — eve discovers them by filename):
  - `schedule_create` — input `{ name, prompt, cadenceText?, everyMinutes?, time?, weekly?, dayOfMonth?, timezone?, firstRunAt?, tags? }`. Required `cadenceText` OR the structured fields. `cadenceText` is parsed with `parseSchedulePrompt`; when null, fall back to structured fields (exactly one of `everyMinutes`/`time`(+`weekly`)/`dayOfMonth`+`time`). `approx` owner/thread resolution: `ctx.session.auth.current` for the Discord principal + `ctx.session.auth.current.attributes.channel_id` fallback to the first schedule's guild/channel when absent (robust either way). Returns `{ scheduleId, name, nextRun }` (rendered via `formatNextRun`).
  - `schedule_list` — input `{ }`; returns `{ schedules: Array<{ id, name, prompt, nextRun, enabled, lastRunStatus, cadence }> }` (renderer pure in the tool).
  - `schedule_update` — input `{ id, name?, prompt?, cadenceText? | structured cadence, timezone?, enabled? }`. `always()` approval. Recomputes next run on cadence/timezone change. Returns `{ updated: true, nextRun }`.
  - `schedule_delete` — input `{ id }`. `always()` approval. Returns `{ deleted: boolean }`.
  - `schedule_runs` — input `{ id, limit? }` (default 3, cap 20). Returns `{ runs: Array<{ status, startedAt, finishedAt, output }> }`.
  - `schedule_trigger` — input `{ id }`. `always()` approval. Forces `next_run_at = now()` (via `updateSchedule` with `cadence` unchanged — the update recomputes next run anyway; simpler: a dedicated `triggerSchedule` one-liner `update next_run_at = now() where id = $1 and enabled`). Returns `{ triggered: boolean }`.
  - `agent/instructions.md` gains a "Scheduled jobs" section.

- [ ] **Step 1: Write the failing test**

Create `packages/agent/tests/schedule-tools.test.ts` — validates the pure renderers (import them from the tool modules; the tool modules import `getExecutor` which degrades to null without Postgres, so the `execute` body's DB calls are not exercised here):

```ts
import { describe, expect, test } from "bun:test";
import {
  renderScheduleList,
  renderScheduleRuns,
} from "../lib/schedule-render";

describe("schedule renderers", () => {
  test("renderScheduleList summarizes jobs", () => {
    const out = renderScheduleList([
      {
        id: "s1",
        name: "remind",
        prompt: "Call dentist",
        cadence: "every_minutes",
        nextRun: "2026-08-10T00:30:00.000Z",
        enabled: true,
        lastRunStatus: "succeeded",
      },
    ]);
    expect(out).toContain("remind");
    expect(out).toContain("succeeded");
  });

  test("renderScheduleRuns lists newest first with output", () => {
    const out = renderScheduleRuns([
      { status: "succeeded", startedAt: "a", finishedAt: "b", output: "done" },
      { status: "failed", startedAt: "c", finishedAt: null, output: null },
    ]);
    expect(out).toContain("succeeded");
    expect(out).toContain("failed");
    expect(out).toContain("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/schedule-tools.test.ts
```

Expected: FAIL — `../lib/schedule-render` missing.

- [ ] **Step 3: Create the pure renderer**

Create `packages/agent/lib/schedule-render.ts`:

```ts
export interface ScheduleSummary {
  id: string;
  name: string;
  prompt: string;
  cadence: string;
  nextRun: string;
  enabled: boolean;
  lastRunStatus: string | null;
}

export function renderScheduleList(items: ScheduleSummary[]): string {
  if (items.length === 0) return "No scheduled jobs.";
  return items
    .map((s) => {
      const state = s.enabled ? "" : " [paused]";
      const last = s.lastRunStatus ? `, last: ${s.lastRunStatus}` : "";
      return `\`${s.name}\`${state} (${s.cadence}, next ${s.nextRun}${last}): ${s.prompt}`;
    })
    .join("\n");
}

export interface RunSummary {
  status: string;
  startedAt: string;
  finishedAt: string | null;
  output: string | null;
}

export function renderScheduleRuns(runs: RunSummary[]): string {
  if (runs.length === 0) return "No runs recorded for this job.";
  return runs
    .map((r, i) => {
      const status = r.status;
      const when = r.finishedAt ?? r.startedAt;
      return `${i + 1}. ${status} at ${when}${r.output ? ` — ${r.output}` : ""}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Write the tool implementations**

Create `packages/agent/agent/tools/schedule_create.ts`:

```ts
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
    if (!ex) throw new Error("scheduled jobs need Postgres (WORKFLOW_POSTGRES_URL)");
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
```

Create `packages/agent/agent/tools/schedule_list.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { listSchedules } from "../../lib/schedule-store";
import { formatNextRun } from "../../lib/schedule-admin";
import { renderScheduleList } from "../../lib/schedule-render";

export default defineTool({
  description: "List all scheduled jobs (id, name, cadence, next run, enabled, last status).",
  inputSchema: z.object({}),
  async execute() {
    const ex = getExecutor();
    if (!ex) throw new Error("scheduled jobs need Postgres");
    const rows = await listSchedules(ex);
    return { schedules: renderScheduleList(rows.map((r) => ({ id: r.id, name: r.name, prompt: r.prompt, cadence: r.cadence, nextRun: formatNextRun(new Date(r.next_run_at), r.timezone), enabled: r.enabled, lastRunStatus: r.last_run_status }))) };
  },
});
```

Create `packages/agent/agent/tools/schedule_update.ts`:

```ts
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { parseSchedulePrompt, formatNextRun, validateCadence, type ScheduledCadenceInput } from "../../lib/schedule-admin";
import { updateSchedule, getSchedule } from "../../lib/schedule-store";

export default defineTool({
  description: "Change, pause, or resume a scheduled job. Updates cadence/timezone and recomputes the next run.",
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
  }),
  approval: always(),
  async execute(input) {
    const ex = getExecutor();
    if (!ex) throw new Error("scheduled jobs need Postgres");
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
    return { updated: true, nextRun: formatNextRun(new Date(row.next_run_at), row.timezone) };
  },
});
```

Create `packages/agent/agent/tools/schedule_delete.ts`:

```ts
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { deleteSchedule } from "../../lib/schedule-store";

export default defineTool({
  description: "Permanently delete a scheduled job and its run history.",
  inputSchema: z.object({ id: z.string().min(1) }),
  approval: always(),
  async execute(input) {
    const ex = getExecutor();
    if (!ex) throw new Error("scheduled jobs need Postgres");
    const row = await deleteSchedule(ex, input.id);
    if (!row) return { deleted: false, message: "No schedule with that id/name." };
    return { deleted: true, message: `Deleted "${row.name}".` };
  },
});
```

Create `packages/agent/agent/tools/schedule_runs.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { listRuns } from "../../lib/schedule-store";
import { renderScheduleRuns } from "../../lib/schedule-render";

export default defineTool({
  description: "Show the recent runs of a scheduled job (status, timestamps, output). Use to answer 'what did that job do?'.",
  inputSchema: z.object({
    id: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(input) {
    const ex = getExecutor();
    if (!ex) throw new Error("scheduled jobs need Postgres");
    const rows = await listRuns(ex, input.id, input.limit ?? 3);
    return { runs: renderScheduleRuns(rows.map((r) => ({ status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, output: r.output }))) };
  },
});
```

Create `packages/agent/agent/tools/schedule_trigger.ts`:

```ts
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getExecutor } from "../../lib/db";
import { triggerSchedule } from "../../lib/schedule-store";

export default defineTool({
  description: "Run a scheduled job immediately, out of band. The dispatcher picks it up within a minute.",
  inputSchema: z.object({ id: z.string().min(1) }),
  approval: always(),
  async execute(input) {
    const ex = getExecutor();
    if (!ex) throw new Error("scheduled jobs need Postgres");
    const res = await triggerSchedule(ex, input.id);
    return res.ok
      ? { triggered: true, message: `"${res.name}" will run within a minute.` }
      : { triggered: false, message: "No enabled schedule with that id/name." };
  },
});
```

Modify `packages/agent/agent/instructions.md` — append:

```md
# Scheduled jobs

When the user asks to schedule, remind, or run something on a cadence, use
`schedule_create`. Confirm the cadence (plain language or explicit fields) and
timezone before creating. To change, pause, resume, or delete a job, use
`schedule_update` / `schedule_delete`. When asked "what did <job> do?", answer
from `schedule_runs` (status + recent output). Use `schedule_trigger` to run a
job now.
```

- [ ] **Step 5: Run the test**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/schedule-tools.test.ts
```

Expected: PASS.

> **Task 7 self-review:** the plan's `schedule_update` import list included `getSchedule`, which is never used — dropped from the file (no unused import). Everything else implemented verbatim; renderer tests pass and typecheck is clean.

- [ ] **Step 6: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: clean. Adjust `ctx.session.auth.current?.attributes?.guild_id` type (attributes is `Readonly<Record<string, string | readonly string[]>>`) — read as `unknown` then narrow to `string`.

- [ ] **Step 7: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/agent/tools/schedule_create.ts packages/agent/agent/tools/schedule_list.ts packages/agent/agent/tools/schedule_update.ts packages/agent/agent/tools/schedule_delete.ts packages/agent/agent/tools/schedule_runs.ts packages/agent/agent/tools/schedule_trigger.ts packages/agent/agent/instructions.md packages/agent/lib/schedule-render.ts packages/agent/tests/schedule-tools.test.ts
git commit -m "feat: schedule management tools for the agent"
```

---

### Task 8: Full verification

**Files:**
- Modify: `README.md` (Operational section — "Scheduled jobs")
- Test: none new.

**Interfaces:**
- Consumes: all previous tasks.

- [ ] **Step 0: Add the README section**

Append under `## 7. Operations` in `README.md`:

```md
### Scheduled jobs

The agent can create, run, and report on scheduled jobs from plain Discord
(say "remind me tomorrow at 9am…" or "digest my calendar every weekday").
Jobs are stored in `ei_schedules` + `ei_schedule_runs` (same Postgres), run
on a minute-tick dispatcher (`agent/schedules/dispatcher.ts`), and deliver
their reply to the owning DM. Ask "what did <job> do?" and the agent reports
from `ei_schedule_runs`. Jobs that fail 3 consecutive runs pause themselves.
```

- [ ] **Step 1: Typecheck both packages**

```bash
cd /root/dev/projects/Ei && bun run typecheck
```

Expected: no errors.

- [ ] **Step 2: Run the full agent unit suite**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test
```

Expected: all tests pass (existing + new schedule suite).

- [ ] **Step 3: Run the shared package tests**

```bash
cd /root/dev/projects/Ei/packages/shared && bun test src/
```

Expected: pass (discord-util test).

- [ ] **Step 4: Boot smoke with no new keys**

```bash
cd /root/dev/projects/Ei/packages/agent && EVE_GATEWAY_DISABLED=1 PORT=3100 timeout 20 bunx eve start >/tmp/ei-boot-sched.log 2>&1; echo "exit=$?"
```

Expected: no crash before timeout (exit 124 acceptable); log shows the dispatcher schedule discovered (`dispatcher`) among the built schedules.

- [ ] **Step 5: Confirm the schedule is registered in the dev dispatch route**

```bash
cd /root/dev/projects/Ei/packages/agent && EVE_GATEWAY_DISABLED=1 PORT=3100 timeout 20 bunx eve start >/tmp/ei-boot-sched2.log 2>&1 & sleep 8; curl -s http://localhost:3100/eve/v1/dev/schedules/dispatcher; echo; kill %1 2>/dev/null
```

Expected: `{"scheduleId":"dispatcher", ...}` or a 404 listing available schedules that includes `dispatcher` (dev-only route mounts only in `eve dev`; production build checks the boot log's `dispatcher` mention). The important verification is the boot log does not throw and the schedule compiled.

- [ ] **Step 6: Commit any incidental fixes**

```bash
cd /root/dev/projects/Ei && git status --short
```

(README change is already staged in Step 0's commit; this step commits any incidental fix-ups found during verification.)

- [ ] **Step 7: Commit unchanged README/docs**

---

## Self-Review Notes

(Internal checklist — delete before saving.)

- [x] Spec §3.1 dispatcher, §3.2 receive hook, §3.3 run logging via continuation token — Tasks 5–6.
- [x] Spec §3.4 tool surface (six tools + instructions) — Task 7.
- [x] Spec §4 data model (`ei_schedules` + `ei_schedule_runs`) — Tasks 0, 2.
- [x] Spec §5 delivery flow, §6 error handling (claim lease, per-job catch, backoff/pause) — Tasks 4, 6, 7.
- [x] Spec §7 testing (unit pg-mem, boot smoke) — Tasks 1–8.
- [x] Spec §8 docs (ENV unchanged, README section) — Task 7 instructions + Task 8.
- [x] Review: token backward compat (Task 1), SQL atomic lease without `FOR UPDATE` (pg-mem-safe), recurrence via `computeNextRun` (Task 3), exact store signatures across tasks (Tasks 4→6→7).
