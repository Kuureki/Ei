import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { jsonValue, migrate, type SqlExecutor } from "../lib/db";
import {
  clearActiveIfProvider,
  deleteProvider,
  getActiveModel,
  getProvider,
  listProviders,
  setActiveModel,
  slugify,
  upsertProvider,
} from "../lib/providers";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

describe("providers", () => {
  test("slugify", () => {
    expect(slugify("Groq API")).toBe("groq-api");
    expect(slugify("OpenAI")).toBe("openai");
  });

  test("upsert/list/delete lifecycle", async () => {
    const ex = await memExecutor();
    await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "PROVIDER_GROQ_API_KEY" });
    const rows = await listProviders(ex);
    expect(rows).toHaveLength(1);
    const p = await getProvider(ex, "groq");
    expect(p?.key_env).toBe("PROVIDER_GROQ_API_KEY");
    await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "PROVIDER_GROQ_API_KEY", enabled: false });
    expect((await getProvider(ex, "groq"))?.enabled).toBe(false);
    const removed = await deleteProvider(ex, "groq");
    expect(removed?.id).toBe("groq");
    expect(await listProviders(ex)).toHaveLength(0);
  });

  test("active model set/clear with version bump", async () => {
    const ex = await memExecutor();
    await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "K" });
    await setActiveModel(ex, { provider_id: "groq", model_id: "m1" });
    expect(await getActiveModel(ex)).toEqual({ provider_id: "groq", model_id: "m1" });
    await setActiveModel(ex, null);
    expect(await getActiveModel(ex)).toBeNull();
  });

  test("clearActiveIfProvider clears only when active", async () => {
    const ex = await memExecutor();
    await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "K" });
    await upsertProvider(ex, { name: "Other", base_url: "https://api.other.com/v1", key_env: "K2" });
    await setActiveModel(ex, { provider_id: "groq", model_id: "m1" });
    await clearActiveIfProvider(ex, "groq");
    expect(await getActiveModel(ex)).toBeNull();
    await setActiveModel(ex, { provider_id: "other", model_id: "m2" });
    await clearActiveIfProvider(ex, "groq");
    expect(await getActiveModel(ex)).toEqual({ provider_id: "other", model_id: "m2" });
  });
});
