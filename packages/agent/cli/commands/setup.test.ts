// cli/commands/setup.test.ts
import { describe, expect, test } from "bun:test";
import { planSetup } from "./setup";

const cfg = { checkoutPath: "/opt/ei", unitName: "ei", dopplerProject: "ei", dopplerConfig: "prd" };

test("planSetup renders a deterministic ordered plan", () => {
  const plan = planSetup(cfg);
  expect(plan.map((s) => s.label)).toEqual([
    "Preflight",
    "doppler project + config",
    "sync env to doppler",
    "bun install",
    "postgres schema",
    "typecheck",
    "build:agent",
    "install sentrux",
    "register-commands",
    "write config",
    "systemd unit",
    "start + health",
  ]);
});

test("planSetup marks the systemd step when systemd is absent", () => {
  const plan = planSetup(cfg, { hasSystemd: false });
  const systemd = plan.find((s) => s.action === "systemd");
  expect(systemd?.label).toBe("systemd unit (manual instructions)");
});
