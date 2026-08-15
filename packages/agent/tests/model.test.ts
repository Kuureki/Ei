import { describe, expect, test } from "bun:test";
import { buildLanguageModel, renderHeaders, reasoningMiddleware } from "../lib/model";

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
  test("wraps the model when a reasoning level is set", () => {
    const lm = buildLanguageModel(src, { PROVIDER_GROQ_API_KEY: "sek" }, "high");
    expect(lm).not.toBeNull();
    expect(typeof (lm as any).doGenerate).toBe("function");
    expect((lm as any).modelId).toBe("llama-3.3-70b-versatile");
  });
  test("does not wrap for none", () => {
    const lm = buildLanguageModel(src, { PROVIDER_GROQ_API_KEY: "sek" }, "none");
    expect(typeof (lm as any).modelId).toBe("string");
  });
});

describe("reasoningMiddleware", () => {
  test("injects reasoningEffort into providerOptions and keeps existing options", async () => {
    const mw = reasoningMiddleware("groq", "high");
    const out = await mw.transformParams!({
      type: "generate",
      model: {} as never,
      params: {
        providerOptions: { other: { flag: true } },
        prompt: "hi",
      } as never,
    });
    const opts = (out as any).providerOptions;
    expect(opts.groq.reasoningEffort).toBe("high");
    expect(opts.other.flag).toBe(true);
    expect((out as any).prompt).toBe("hi");
  });
  test("creates providerOptions when absent", async () => {
    const mw = reasoningMiddleware("groq", "low");
    const out = await mw.transformParams!({ type: "stream", model: {} as never, params: {} as never });
    expect((out as any).providerOptions.groq.reasoningEffort).toBe("low");
  });
});
