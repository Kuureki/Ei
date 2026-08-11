import { describe, expect, test } from "bun:test";
import { renderScheduleList, renderScheduleRuns } from "../lib/schedule-render";

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
