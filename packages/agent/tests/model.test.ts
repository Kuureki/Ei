import { describe, expect, test } from "bun:test";
import { buildLanguageModel, renderHeaders } from "../lib/model";

describe("renderHeaders", () => {
  test("interpolates ${env:NAME} refs and skips junk", () => {
    expect(renderHeaders(JSON.stringify({ "X-Key": "${env:PROVIDER_GROQ_API_KEY}", "X-Static": "v" }), {
      PROVIDER_GROQ_API_KEY: "sek",
    })).toEqual({ "X-Key": "sek", "X-Static": "v" });
    expect(renderHeaders("not json", {})).toBeUndefined();
    expect(renderHeaders(null, {})).toBeUndefined();
  });
});

describe("buildLanguageModel", () => {
  const src = {
    provider_id: "groq",
    base_url: "https://api.groq.com/openai/v1",
    key_env: "PROVIDER_GROQ_API_KEY",
    headers_json: null,
    model_id: "llama-3.3-70b-versatile",
  };
  test("returns null when the key env is missing", () => {
    expect(buildLanguageModel(src, {})).toBeNull();
  });
  test("returns a live LanguageModel when the key is present", () => {
    const lm = buildLanguageModel(src, { PROVIDER_GROQ_API_KEY: "sek" });
    expect(lm).not.toBeNull();
    expect(typeof (lm as any).doGenerate).toBe("function");
    expect((lm as any).modelId).toBe("llama-3.3-70b-versatile");
  });
});
