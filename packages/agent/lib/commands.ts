// Slash-command handlers for the BYOK provider registry.
import { isPublicHttpUrl } from "@ei/shared";
import { generateText } from "ai";
import type { SqlExecutor } from "./db";
import { discoverModels, type DiscoverModelRow } from "./discovery";
import { buildLanguageModel } from "./model";
import {
  cacheCounts,
  clearActiveIfProvider,
  deleteProvider,
  getActiveModel,
  getProvider,
  listModelsForAutocomplete,
  listProviders,
  replaceModels,
  setActiveModel,
  slugify,
  upsertProvider,
} from "./providers";

export interface CommandDeps {
  ex: SqlExecutor;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export const KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function isValidKeyEnv(v: string): boolean {
  return KEY_ENV_PATTERN.test(v);
}

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export async function suggestModels(ex: SqlExecutor, query: string): Promise<AutocompleteChoice[]> {
  const rows = await listModelsForAutocomplete(ex, query.trim());
  return rows.map((r) => {
    const label = r.label ? ` — ${r.label}` : "";
    const ctx = r.context_window != null ? `, ${(r.context_window / 1000).toFixed(0)}k ctx` : "";
    return {
      name: `${r.provider_id}/${r.model_id}${label}${ctx}`.slice(0, 100),
      value: r.model_id,
    };
  });
}

async function runDiscovery(deps: CommandDeps, providerId: string): Promise<DiscoverModelRow[]> {
  const p = await getProvider(deps.ex, providerId);
  if (!p) throw new Error("provider not found");
  const apiKey = deps.env[p.key_env];
  const result = await discoverModels({
    baseUrl: p.base_url,
    name: p.name,
    apiKey,
    ex: deps.ex,
    fetchImpl: deps.fetchImpl,
  });
  await replaceModels(deps.ex, p.id, result.rows);
  return result.rows;
}

export async function handleAutocomplete(deps: CommandDeps, _command: string, query: string): Promise<{ choices: AutocompleteChoice[] }> {
  const choices = await suggestModels(deps.ex, query);
  return { choices: choices.slice(0, 25) };
}

export async function handleCommand(
  deps: CommandDeps,
  command: string,
  options: Record<string, string | boolean>,
): Promise<{ reply: string }> {
  switch (command) {
    case "list":
      return { reply: await formatProviderList(deps.ex, deps.env) };
    case "edit":
      return editProvider(deps, options);
    case "remove":
      return removeProvider(deps, options);
    case "test":
      return testProvider(deps, options);
    case "refresh":
      return refreshProvider(deps, options);
    case "use":
      return useModel(deps, options);
    default:
      return { reply: "Unknown provider command." };
  }
}

export async function handleModalSubmit(
  deps: CommandDeps,
  customId: string,
  values: Record<string, string>,
): Promise<{ reply: string }> {
  if (customId !== "provider_add") return { reply: "Unknown modal." };
  const name = (values.name ?? "").trim();
  const baseUrl = (values.base_url ?? "").trim();
  const keyEnv = (values.key_env ?? "").trim();
  if (!name || !baseUrl || !keyEnv) return { reply: "name, base_url, and key_env are required." };
  if (!isPublicHttpUrl(baseUrl)) return { reply: "base_url must be a public http(s) URL." };
  if (!isValidKeyEnv(keyEnv)) return { reply: "key_env must look like an env var name (e.g. PROVIDER_GROQ_API_KEY)." };
  const headers = (values.headers ?? "").trim() || null;
  if (headers && !isValidJson(headers)) return { reply: "headers must be valid JSON." };
  try {
    const existing = await getProvider(deps.ex, slugify(name));
    if (existing) return { reply: `Provider "${name}" already exists. Use /provider edit.` };
    await upsertProvider(deps.ex, { name, base_url: baseUrl, key_env: keyEnv, headers_json: headers });
    const rows = await runDiscovery(deps, slugify(name));
    const keySet = Boolean(deps.env[keyEnv]);
    const tip = keySet ? "" : `\nSet its secret with: doppler secrets set ${keyEnv}=...`;
    return { reply: `Registered "${name}" at ${baseUrl}. ${rows.length} model(s) cached.${tip}` };
  } catch (err) {
    return { reply: `Add failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function editProvider(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const name = String(options.name ?? "");
  const p = await getProvider(deps.ex, name);
  if (!p) return { reply: `No provider named "${name}".` };
  const next = {
    name: p.name,
    base_url: typeof options.base_url === "string" ? options.base_url : p.base_url,
    key_env: typeof options.key_env === "string" ? options.key_env : p.key_env,
    headers_json: p.headers_json,
    enabled: typeof options.enabled === "boolean" ? options.enabled : p.enabled,
  };
  if (!isPublicHttpUrl(next.base_url)) return { reply: "base_url must be a public http(s) URL." };
  if (!isValidKeyEnv(next.key_env)) return { reply: "key_env must look like an env var name." };
  const baseUrlChanged = next.base_url !== p.base_url;
  await upsertProvider(deps.ex, next);
  let extra = "";
  if (baseUrlChanged) {
    const rows = await runDiscovery(deps, p.id);
    extra = ` Discovery re-ran: ${rows.length} model(s).`;
  }
  return { reply: `Updated "${p.name}".${extra}` };
}

async function removeProvider(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const name = String(options.name ?? "");
  const removed = await deleteProvider(deps.ex, name);
  if (!removed) return { reply: `No provider named "${name}".` };
  await clearActiveIfProvider(deps.ex, removed.id);
  return { reply: `Removed provider "${removed.name}".` };
}

const EXAMPLE_PROMPT = "Reply with exactly: ok";

async function testProvider(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const name = String(options.name ?? "");
  const p = await getProvider(deps.ex, name);
  if (!p) return { reply: `No provider named "${name}".` };
  const apiKey = deps.env[p.key_env];
  if (!apiKey) return { reply: `Secret ${p.key_env} is not set in this environment. Set it with: doppler secrets set ${p.key_env}=...` };
  const cached = await deps.ex.query(`select model_id from ei_models_cache where provider_id = $1 order by model_id limit 1`, [p.id]);
  const active = await getActiveModel(deps.ex);
  const modelId =
    active && active.provider_id === p.id
      ? active.model_id
      : cached.rows.length
        ? String(cached.rows[0].model_id)
        : null;
  if (!modelId) {
    await deps.ex.query(
      `update ei_providers set last_tested_at = now(), last_test_ok = false, last_test_error = $1, updated_at = now() where id = $2`,
      ["no cached models", p.id],
    );
    return { reply: `No cached models for "${p.name}". Run /provider refresh first.` };
  }
  const model = buildLanguageModel({ provider_id: p.id, base_url: p.base_url, key_env: p.key_env, headers_json: p.headers_json, model_id: modelId }, deps.env);
  if (!model) return { reply: `Could not build a model client for "${p.name}".` };
  const started = Date.now();
  try {
    await generateText({ model, prompt: EXAMPLE_PROMPT, maxOutputTokens: 4 });
    const ms = Date.now() - started;
    await deps.ex.query(`update ei_providers set last_tested_at = now(), last_test_ok = true, last_test_error = null, updated_at = now() where id = $1`, [p.id]);
    return { reply: `OK for "${p.name}" via ${modelId} (${ms} ms).` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.ex.query(`update ei_providers set last_tested_at = now(), last_test_ok = false, last_test_error = $1, updated_at = now() where id = $2`, [msg, p.id]);
    return { reply: `"${p.name}" test failed: ${msg}` };
  }
}

async function refreshProvider(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const name = String(options.name ?? "");
  const p = await getProvider(deps.ex, name);
  if (!p) return { reply: `No provider named "${name}".` };
  const apiKey = deps.env[p.key_env];
  const result = await discoverModels({ baseUrl: p.base_url, name: p.name, apiKey, ex: deps.ex, fetchImpl: deps.fetchImpl, forceCatalog: true });
  await replaceModels(deps.ex, p.id, result.rows);
  const endpointNote = result.endpointError ? ` (endpoint: ${result.endpointError})` : "";
  return { reply: `Refreshed "${p.name}": ${result.rows.length} model(s).${endpointNote}` };
}

async function useModel(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const modelId = String(options.model ?? "");
  const rows = await listModelsForAutocomplete(deps.ex, modelId);
  const match = rows.find((r) => r.model_id === modelId);
  if (!match) return { reply: `Unknown model "${modelId}". Pick one from the autocomplete list.` };
  await setActiveModel(deps.ex, { provider_id: match.provider_id, model_id: modelId });
  return { reply: `Active model set to ${match.provider_id}/${modelId}. Applies from your next message.` };
}

export async function formatProviderList(ex: SqlExecutor, env: Record<string, string | undefined>): Promise<string> {
  const providers = await listProviders(ex);
  if (!providers.length) return "No providers configured. Use /provider add.";
  const active = await getActiveModel(ex);
  const lines: string[] = [];
  for (const p of providers) {
    const counts = await cacheCounts(ex, p.id);
    const total = counts.endpoint + counts.catalog;
    const key = env[p.key_env] ? "set" : "unset";
    const state = p.enabled ? "" : " [disabled]";
    const activeMark = active?.provider_id === p.id ? "  ⭐ ACTIVE" : "";
    lines.push(
      `\`${p.name}\`${state}: ${p.base_url} (key: ${key}, models: ${total}, endpoint: ${counts.endpoint}, catalog: ${counts.catalog})${activeMark}`,
    );
    if (active?.provider_id === p.id) lines.push(`  → ${active.model_id}`);
  }
  return lines.join("\n");
}
