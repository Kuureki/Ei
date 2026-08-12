import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { jsonValue, migrate, type SqlExecutor } from "../lib/db";
import { replaceModels, setActiveModel, upsertProvider } from "../lib/providers";
import { formatProviderList, handleAutocomplete, handleCommand, handleModalSubmit, suggestModels } from "../lib/commands";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

const ENV: Record<string, string | undefined> = { PROVIDER_GROQ_API_KEY: "sek" };

const FIXTURE: Record<string, any> = {
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B",
        tool_call: true,
        limit: { context: 131072, output: 32768 },
      },
    },
  },
};

async function seed(ex: SqlExecutor, opts: { models?: boolean } = { models: true }) {
  await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "PROVIDER_GROQ_API_KEY" });
  if (opts.models) {
    await replaceModels(ex, "groq", [
      { model_id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", context_window: 131072, output_window: 32768, supports_tool_calls: true, supports_reasoning: false, supports_structured_output: true, price_in: 0.59, price_out: 0.79, source: "catalog" as const },
    ]);
  }
}

describe("suggestModels / autocomplete", () => {
  test("suggests cached models with labels", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const rows = await suggestModels(ex, "llama");
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("llama-3.3-70b-versatile");
    expect(rows[0].name).toContain("Llama 3.3 70B");
  });
  test("handleAutocomplete wraps choices", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { choices } = await handleAutocomplete({ ex, env: ENV }, "use", "llama");
    expect(choices[0].value).toBe("llama-3.3-70b-versatile");
  });
});

describe("handleCommand", () => {
  test("list formats providers with key status", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { reply } = await handleCommand({ ex, env: ENV }, "list", {});
    expect(reply).toContain("Groq");
    expect(reply).toContain("key: set");
    expect(reply).toContain("models: 1");
  });
  test("use sets the active model", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { reply } = await handleCommand({ ex, env: ENV }, "use", { model: "llama-3.3-70b-versatile" });
    expect(reply).toContain("llama-3.3-70b-versatile");
    const cfg = await ex.query(`select value from config where key = 'active_model'`);
    expect(jsonValue(cfg.rows[0].value)).toEqual({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" });
  });
  test("use rejects an unknown model id", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { reply } = await handleCommand({ ex, env: ENV }, "use", { model: "nope" });
    expect(reply.toLowerCase()).toContain("unknown");
  });
  test("remove clears active", async () => {
    const ex = await memExecutor();
    await seed(ex);
    await setActiveModel(ex, { provider_id: "groq", model_id: "llama-3.3-70b-versatile" });
    const { reply } = await handleCommand({ ex, env: ENV }, "remove", { name: "Groq" });
    expect(reply.toLowerCase()).toContain("removed");
    const cfg = await ex.query(`select value from config where key = 'active_model'`);
    expect(jsonValue(cfg.rows[0].value)).toBeNull();
  });
  test("edit rejects a private base_url", async () => {
    const ex = await memExecutor();
    await seed(ex, { models: false });
    const { reply } = await handleCommand({ ex, env: ENV }, "edit", { name: "Groq", base_url: "http://localhost:9999/v1" });
    expect(reply.toLowerCase()).toContain("url");
  });
  test("test reports when the key env is missing", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { reply } = await handleCommand({ ex, env: {} }, "test", { name: "Groq" });
    expect(reply).toContain("PROVIDER_GROQ_API_KEY");
  });
});

describe("handleModalSubmit", () => {
  test("provider_add registers and discovers", async () => {
    const ex = await memExecutor();
    const fetchImpl = (async (url: unknown) =>
      String(url).includes("models.dev")
        ? new Response(JSON.stringify(FIXTURE), { status: 200 })
        : new Response("nope", { status: 404 })) as typeof fetch;
    const { reply } = await handleModalSubmit({ ex, env: ENV, fetchImpl }, "provider_add", {
      name: "Groq",
      base_url: "https://api.groq.com/openai/v1",
      key_env: "PROVIDER_GROQ_API_KEY",
    });
    expect(reply).toContain("Groq");
    expect(reply).toContain("Registered");
  });
});

describe("formatProviderList", () => {
  test("marks the active provider", async () => {
    const ex = await memExecutor();
    await seed(ex);
    await setActiveModel(ex, { provider_id: "groq", model_id: "llama-3.3-70b-versatile" });
    const text = await formatProviderList(ex, ENV);
    expect(text).toContain("ACTIVE");
  });
});
