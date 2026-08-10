import { describe, expect, test, afterEach } from "bun:test";
import instrumentation from "../agent/instrumentation";

afterEach(() => {
  delete process.env.POSTHOG_PROJECT_TOKEN;
  delete (globalThis as any).__otelRegistered;
});

describe("instrumentation", () => {
  test("setup no-ops when POSTHOG_PROJECT_TOKEN is unset", () => {
    delete process.env.POSTHOG_PROJECT_TOKEN;
    instrumentation.setup({ agentName: "ei" });
    expect((globalThis as any).__otelRegistered ?? false).toBe(false);
  });
});
