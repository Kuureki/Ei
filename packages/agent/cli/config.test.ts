// cli/config.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configPath, findCheckout, readConfig, writeConfig } from "./config";

const dir = path.join(tmpdir(), `ei-config-test-${process.pid}`);
beforeAll(() => mkdirSync(dir, { recursive: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("configPath honors XDG_CONFIG_HOME", () => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    expect(configPath()).toBe(path.join(dir, "ei", "config.json"));
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
  }
});

test("writeConfig then readConfig round-trips", async () => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    writeConfig({ checkoutPath: "/opt/ei", unitName: "ei", dopplerProject: "ei" });
    const cfg = await readConfig({});
    expect(cfg.checkoutPath).toBe("/opt/ei");
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
  }
});

test("flags override file values", async () => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    const cfg = await readConfig({ checkout: "/elsewhere", unit: "my-ei" });
    expect(cfg.checkoutPath).toBe("/elsewhere");
    expect(cfg.unitName).toBe("my-ei");
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
  }
});
