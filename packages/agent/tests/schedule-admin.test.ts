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

  test("weekly_on respects the allowed weekdays (1 = Monday)", () => {
    // Aug 10 2026 is a Monday. weekly [2,4] = Tuesday, Thursday.
    const next = computeNextRun(aug10_0000, { kind: "weekly_on", time: "09:00", weekly: [2, 4] }, "UTC");
    expect(iso(next)).toBe("2026-08-11T09:00:00.000Z"); // Tuesday
  });

  test("daily_at created after the daily time lands next day", () => {
    const late = new Date("2026-08-10T23:00:00.000Z");
    const next = computeNextRun(late, { kind: "daily_at", time: "08:00" }, "UTC");
    expect(iso(next)).toBe("2026-08-11T08:00:00.000Z");
  });

  test("monthly_on clamps to the last day of short months", () => {
    // Jan 31, after the 10:00 target already passed -> next is Feb 28 10:00
    // (2026 is not a leap year).
    const after = new Date("2026-01-31T12:00:00.000Z");
    const next = computeNextRun(after, { kind: "monthly_on", dayOfMonth: 31, time: "10:00" }, "UTC");
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
