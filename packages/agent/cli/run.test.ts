// cli/run.test.ts
import { describe, expect, test } from "bun:test";
import { run } from "./run";

describe("run", () => {
  test("captures stdout and ok", async () => {
    const r = await run(["echo", "hello"]);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("hello");
  });
  test("reports nonzero and stderr", async () => {
    const r = await run(["sh", "-c", "echo bad >&2; exit 3"]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("bad");
  });
  test("missing binary fails gracefully", async () => {
    const r = await run(["this-command-does-not-exist-xyz"]);
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
  });
});
