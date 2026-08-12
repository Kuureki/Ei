// cli/upgrade.test.ts
import { describe, expect, test } from "bun:test";
import { decideUpgrade, planUpgrade } from "./upgrade";
import { latestRelease } from "./version";

describe("decideUpgrade", () => {
  test("self-updates when binary older than latest", () => {
    const d = decideUpgrade("v0.4.0", "v0.4.2", "v0.4.2");
    expect(d.selfUpdate).toBe(true);
    expect(d.agentUpdate).toBe(false);
  });
  test("skips self-update when bottled dev build", () => {
    const d = decideUpgrade("dev", "v0.4.2", "v0.4.0");
    expect(d.selfUpdate).toBe(false);
    expect(d.agentUpdate).toBe(true);
  });
  test("no-op when already at latest", () => {
    const d = decideUpgrade("v0.4.2", "v0.4.2", "v0.4.2");
    expect(d.selfUpdate).toBe(false);
    expect(d.agentUpdate).toBe(false);
  });
  test("agent update needed when checkout is behind", () => {
    const d = decideUpgrade("v0.4.2", "v0.4.2", "");
    expect(d.agentUpdate).toBe(true);
  });
});

test("planUpgrade lists deterministic steps", () => {
  const plan = planUpgrade(
    { checkoutPath: "/opt/ei", unitName: "ei", dopplerProject: "ei" },
    { selfUpdate: true, agentUpdate: true, reason: "v0.4.0 -> v0.4.2" },
    "/opt/ei/bin/ei",
    "v0.4.2",
  );
  expect(plan).toContain("download ei-linux-x64 -> /opt/ei/bin/ei (v0.4.2)");
  expect(plan).toContain("git checkout v0.4.2");
});

test("latestRelease resolves the asset map", async () => {
  const fake = async () =>
    ({ ok: true, json: async () => ({
      tag_name: "v0.4.2",
      assets: [
        { name: "ei-linux-x64", browser_download_url: "https://github.com/Kuureki/Ei/releases/download/v0.4.2/ei-linux-x64" },
        { name: "ei-linux-arm64", browser_download_url: "https://github.com/Kuureki/Ei/releases/download/v0.4.2/ei-linux-arm64" },
      ],
    }) }) as Response;
  const rel = await latestRelease({ fetchImpl: fake });
  expect(rel.tag).toBe("v0.4.2");
  expect(rel.assets["ei-linux-x64"]).toContain("ei-linux-x64");
});
