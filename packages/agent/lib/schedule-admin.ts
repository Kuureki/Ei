// Pure cadence/timezone math for scheduled jobs. No DB, no env access.
export type ScheduledCadenceInput =
  | { kind: "every_minutes"; everyMinutes: number }
  | { kind: "daily_at"; time: string }
  | { kind: "weekly_on"; time: string; weekly: number[] }
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
      if (!input.weekly.length || input.weekly.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
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
const DAY_MS = 86_400_000;
const WEEKDAY_INDEX = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getTzParts(tz: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
}

type TzParts = ReturnType<typeof getTzParts>;

function wallTimeInTz(d: Date, tz: string, fmt: TzParts): { h: number; m: number; dom: number } {
  const parts = fmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { h: get("hour"), m: get("minute"), dom: get("day") };
}

function weekdayInTz(d: Date, tz: string): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  return WEEKDAY_INDEX.indexOf(s);
}

// Absolute next-run instant strictly after `from`, in IANA `timezone`.
export function computeNextRun(from: Date, input: ScheduledCadenceInput, timezone: string): Date {
  validateCadence(input);
  // Resolve the tz (throws on invalid IANA names) exactly like production storage does.
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  const fmt = getTzParts(tz);

  switch (input.kind) {
    case "every_minutes":
      return new Date(from.getTime() + input.everyMinutes * MINUTE_MS);

    case "daily_at": {
      const [h, m] = input.time.split(":").map(Number);
      let dayStart = startOfNextDay(from, tz, fmt);
      // Bound: 2 days covers the daily target even when created right after it.
      for (let day = 0; day < 2; day++) {
        for (let i = 0; i < 24 * 60; i++) {
          const cand = new Date(dayStart.getTime() + i * MINUTE_MS);
          const wall = wallTimeInTz(cand, tz, fmt);
          if (wall.h === h && wall.m === m) return cand;
        }
        dayStart = new Date(dayStart.getTime() + DAY_MS);
      }
      throw new Error("could not compute next run (no matching wall-clock time within 2 days)");
    }

    case "weekly_on": {
      const [h, m] = input.time.split(":").map(Number);
      let dayStart = startOfNextDay(from, tz, fmt);
      // Bound: 8 days covers any weekly combination even when created right
      // after the target weekday/time.
      for (let day = 0; day < 8; day++) {
        const wd = weekdayInTz(dayStart, tz);
        if (input.weekly.includes(wd)) {
          for (let i = 0; i < 24 * 60; i++) {
            const cand = new Date(dayStart.getTime() + i * MINUTE_MS);
            const wall = wallTimeInTz(cand, tz, fmt);
            if (wall.h === h && wall.m === m) return cand;
          }
        }
        dayStart = new Date(dayStart.getTime() + DAY_MS);
      }
      throw new Error("could not compute next run (weekly_on)");
    }

    case "monthly_on": {
      const [h, m] = input.time.split(":").map(Number);
      let dayStart = startOfNextDay(from, tz, fmt);
      // Bound: 32 days covers a monthly target with month-end clamping and
      // creation right after the target day.
      for (let day = 0; day < 32; day++) {
        const wall = wallTimeInTz(new Date(dayStart.getTime() + 60_000), tz, fmt);
        const lastDay = lastDayOfMonth(dayStart, tz);
        if (wall.dom === Math.min(input.dayOfMonth, lastDay)) {
          for (let i = 0; i < 24 * 60; i++) {
            const cand = new Date(dayStart.getTime() + i * MINUTE_MS);
            const w = wallTimeInTz(cand, tz, fmt);
            if (w.h === h && w.m === m) return cand;
          }
        }
        dayStart = new Date(dayStart.getTime() + DAY_MS);
      }
      throw new Error("could not compute next run (monthly_on)");
    }
  }
}

function startOfNextDay(from: Date, tz: string, fmt: TzParts): Date {
  // Start from `from` + 1 min (strictly after), then walk forward minute by
  // minute (at most a day + slack) until the tz wall-clock day changes.
  let cand = new Date(from.getTime() + MINUTE_MS);
  const fromDay = wallTimeInTz(from, tz, fmt).dom;
  for (let i = 0; i < 24 * 60 + 60; i++) {
    if (wallTimeInTz(cand, tz, fmt).dom !== fromDay) return cand;
    cand = new Date(cand.getTime() + MINUTE_MS);
  }
  return cand;
}

function lastDayOfMonth(d: Date, tz: string): number {
  // The last day of `d`'s month in `tz`: day-number of the day before the
  // first of the following month, via a probe in the same tz.
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(d));
  const month = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric" }).format(d));
  const yearStr = String(year);
  const nextMonth = month === 12 ? 1 : month + 1;
  const probeYear = month === 12 ? year + 1 : year;
  const firstOfNext = new Date(Date.UTC(probeYear, nextMonth - 1, 1));
  const lastOfMonth = new Date(firstOfNext.getTime() - 86_400_000);
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(lastOfMonth),
  );
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
    re: /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))*\s+at\s+(\d{1,2}:\d{2})$/i,
    build: (m) => {
      const days: number[] = [];
      for (let i = 1; i < m.length - 1; i++) {
        if (m[i]) days.push(WEEKDAY_ALIASES[m[i].toLowerCase()]);
      }
      if (!days.length) return null;
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
