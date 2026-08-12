// cli/version.test.ts
import { describe, expect, test } from "bun:test";
import { compareSemver, parseSemver, currentVersion, platformTarget } from "./version";

describe("semver", () => {
  test("parseSemver splits major.minor.patch", () => {
    expect(parseSemver("v0.4.2")).toEqual({ major: 0, minor: 4, patch: 2 });
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  test("compareSemver orders and ignores prerelease", () => {
    expect(compareSemver("v0.4.2", "v0.4.3")).toBe(-1);
    expect(compareSemver("v0.5.0", "v0.4.3")).toBe(1);
    expect(compareSemver("v0.4.2", "v0.4.2-alpha")).toBe(0);
  });
});

test("currentVersion returns dev when unstamped", () => {
  expect(currentVersion()).toBe("dev");
});

test("platformTarget is a bun target string", () => {
  expect(["bun-linux-x64", "bun-linux-arm64"]).toContain(platformTarget());
});
