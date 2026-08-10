import { describe, expect, test } from "bun:test";
import { catalogModelsToRows, matchCatalogEntry } from "../lib/models-dev";
import { discoverModels, fetchEndpointModels, isChatCandidate, mergeDiscoveries } from "../lib/discovery";

// slice of the real models.dev api.json (provider-level map)
const FIXTURE: Record<string, any> = {
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B",
        reasoning: false,
        tool_call: true,
        structured_output: true,
        limit: { context: 131072, output: 32768 },
        cost: { input: 0.59, output: 0.79 },
      },
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    models: {
      "deepseek-v4-flash": { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, tool_call: true, limit: { context: 1000000, output: 384000 } },
    },
  },
};

describe("isChatCandidate", () => {
  test("filters obvious non-chat ids", () => {
    expect(isChatCandidate("gpt-4o")).toBe(true);
    expect(isChatCandidate("text-embedding-3-small")).toBe(false);
    expect(isChatCandidate("whisper-1")).toBe(false);
    expect(isChatCandidate("gpt-image-2")).toBe(false);
    expect(isChatCandidate("llama-3.3-70b-versatile")).toBe(true);
  });
});

describe("matchCatalogEntry", () => {
  test("matches by provider name (case-insensitive)", () => {
    const m = matchCatalogEntry(FIXTURE, "Groq", "https://api.groq.com/openai/v1");
    expect(m?.id).toBe("groq");
  });
  test("matches by base-url host when name is unknown", () => {
    const m = matchCatalogEntry(FIXTURE, "my-deepseek", "https://api.deepseek.com/v1");
    expect(m?.id).toBe("deepseek");
  });
  test("returns null when nothing matches", () => {
    expect(matchCatalogEntry(FIXTURE, "nope", "https://nowhere.example.com")).toBeNull();
  });
});

describe("catalogModelsToRows", () => {
  test("maps fields with catalog source", () => {
    const rows = catalogModelsToRows(FIXTURE.groq, "groq");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model_id: "llama-3.3-70b-versatile",
      label: "Llama 3.3 70B",
      context_window: 131072,
      output_window: 32768,
      supports_tool_calls: true,
      supports_reasoning: false,
      supports_structured_output: true,
      price_in: 0.59,
      price_out: 0.79,
      source: "catalog",
    });
  });
});

describe("fetchEndpointModels", () => {
  test("parses a /models response", async () => {
    const fetchImpl = (async (_url: unknown, _init?: unknown) => new Response(JSON.stringify({ object: "list", data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 })) as typeof fetch;
    const out = await fetchEndpointModels({ baseUrl: "https://api.example.com/v1", fetchImpl });
    expect(out.error).toBeNull();
    expect(out.models).toEqual(["m1", "m2"]);
  });
  test("tolerates 404 with error string", async () => {
    const fetchImpl = (async (_url: unknown, _init?: unknown) => new Response("nope", { status: 404 })) as typeof fetch;
    const out = await fetchEndpointModels({ baseUrl: "https://api.example.com/v1", fetchImpl });
    expect(out.models).toBeNull();
    expect(out.error).toContain("404");
  });
});

describe("mergeDiscoveries", () => {
  test("endpoint wins existence, catalog enriches, source both", () => {
    const rows = mergeDiscoveries({
      endpoint: ["m1", "m2"],
      catalog: [
        { model_id: "m2", label: "M2", context_window: 1000, output_window: 500, supports_tool_calls: true, supports_reasoning: false, supports_structured_output: null, price_in: null, price_out: null, source: "catalog" as const },
      ],
    });
    expect(rows.find((r) => r.model_id === "m1")).toMatchObject({ model_id: "m1", source: "endpoint" });
    const m2 = rows.find((r) => r.model_id === "m2")!;
    expect(m2.source).toBe("both");
    expect(m2.context_window).toBe(1000);
    expect(m2.supports_tool_calls).toBe(true);
  });
});

describe("discoverModels", () => {
  test("combines endpoint + catalog and leaves endpointError null on success", async () => {
    const fetchImpl = (async (url: unknown) =>
      String(url).includes("models.dev")
        ? new Response(JSON.stringify(FIXTURE), { status: 200 })
        : new Response(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] }), { status: 200 })) as typeof fetch;
    const out = await discoverModels({
      baseUrl: "https://api.groq.com/openai/v1",
      name: "Groq",
      fetchImpl,
    });
    expect(out.endpointError).toBeNull();
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].source).toBe("both");
  });
});
