import { describe, expect, test } from "bun:test";
import { runtimeIntakeUrl, shouldStartGateway } from "../lib/gateway/index";
import { getPostgresUrl } from "../lib/db";
import { resolveStepModel } from "../lib/model";

describe("gateway boot guard", () => {
  test("disabled by flag", () => {
    expect(shouldStartGateway({ EVE_GATEWAY_DISABLED: "1" })).toBe(false);
    expect(shouldStartGateway({ EVE_GATEWAY_DISABLED: "true" })).toBe(false);
    expect(shouldStartGateway({})).toBe(true);
  });
  test("intake URLs honor PORT and override", () => {
    expect(runtimeIntakeUrl({ PORT: "8080" }).intake).toBe("http://127.0.0.1:8080/intake");
    expect(runtimeIntakeUrl({ EVE_RUNTIME_URL: "http://host:9" }).interact).toBe("http://host:9/interact");
  });
});

describe("resolveStepModel", () => {
  test("returns null when no database is configured (graceful fallback)", async () => {
    expect(await resolveStepModel({})).toBeNull();
  });
});

describe("db contract", () => {
  test("getPostgresUrl prefers WORKFLOW_POSTGRES_URL, falls back to DATABASE_URL", () => {
    expect(getPostgresUrl({ WORKFLOW_POSTGRES_URL: "pg://a", DATABASE_URL: "pg://b" })).toBe("pg://a");
    expect(getPostgresUrl({ DATABASE_URL: "pg://b" })).toBe("pg://b");
  });
  test("getPostgresUrl throws when no URL is configured", () => {
    expect(() => getPostgresUrl({})).toThrow(/WORKFLOW_POSTGRES_URL is required/);
    expect(() => getPostgresUrl()).toThrow(/WORKFLOW_POSTGRES_URL is required/);
  });
});
