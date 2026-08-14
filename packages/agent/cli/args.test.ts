// cli/args.test.ts
import { describe, expect, test } from "bun:test";
import { parseArgs, ArgsError } from "./args";

describe("parseArgs", () => {
  test("extracts command, positionals, and boolean flags", () => {
    const p = parseArgs(["status", "--json", "extra"]);
    expect(p.command).toBe("status");
    expect(p.positionals).toEqual(["extra"]);
    expect(p.flags.json).toBe(true);
  });
  test("supports --flag=value and --flag value", () => {
    expect(parseArgs(["logs", "--lines=25"]).flags.lines).toBe("25");
    expect(parseArgs(["upgrade", "--checkout", "/srv/ei"]).flags.checkout).toBe("/srv/ei");
    expect(parseArgs(["setup", "--config", "dev"]).flags.config).toBe("dev");
  });
  test("first non-flag token is the command", () => {
    const p = parseArgs(["--dry-run", "setup"]);
    expect(p.command).toBe("setup");
    expect(p.flags["dry-run"]).toBe(true);
  });
  test("throws ArgsError on unknown value flag at end", () => {
    expect(() => parseArgs(["upgrade", "--checkout"])).toThrow(ArgsError);
  });
});
