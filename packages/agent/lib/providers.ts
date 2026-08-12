// Provider registry CRUD + active-model config over SqlExecutor.
import { jsonValue, type SqlExecutor } from "./db";
import type { DiscoverModelRow } from "./discovery";

export interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  key_env: string;
  headers_json: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
}

export interface ProviderInput {
  name: string;
  base_url: string;
  key_env: string;
  headers_json?: string | null;
  enabled?: boolean;
}

export interface ActiveModelConfig {
  provider_id: string;
  model_id: string;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function rowOf(r: Record<string, unknown>): ProviderRow {
  return {
    id: String(r.id),
    name: String(r.name),
    base_url: String(r.base_url),
    key_env: String(r.key_env),
    headers_json: r.headers_json == null ? null : String(r.headers_json),
    enabled: Boolean(r.enabled),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    last_tested_at: r.last_tested_at == null ? null : String(r.last_tested_at),
    last_test_ok: r.last_test_ok == null ? null : Boolean(r.last_test_ok),
    last_test_error: r.last_test_error == null ? null : String(r.last_test_error),
  };
}

export async function listProviders(ex: SqlExecutor): Promise<ProviderRow[]> {
  const r = await ex.query(`select * from providers order by name`);
  return r.rows.map(rowOf);
}

export async function getProvider(ex: SqlExecutor, idOrName: string): Promise<ProviderRow | null> {
  const r = await ex.query(`select * from providers where id = $1 or name = $1 limit 1`, [idOrName]);
  return r.rows.length ? rowOf(r.rows[0]) : null;
}

export async function upsertProvider(ex: SqlExecutor, input: ProviderInput): Promise<ProviderRow> {
  const id = slugify(input.name);
  const headers = input.headers_json ?? null;
  const enabled = input.enabled ?? true;
  await ex.query(
    `insert into providers (id, name, base_url, key_env, headers_json, enabled)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (name) do update set
       base_url = excluded.base_url,
       key_env = excluded.key_env,
       headers_json = excluded.headers_json,
       enabled = excluded.enabled,
       updated_at = now()`,
    [id, input.name, input.base_url, input.key_env, headers, enabled],
  );
  const got = await getProvider(ex, id);
  if (!got) throw new Error("provider write failed");
  return got;
}

export async function deleteProvider(ex: SqlExecutor, idOrName: string): Promise<ProviderRow | null> {
  const existing = await getProvider(ex, idOrName);
  if (!existing) return null;
  await ex.query(`delete from providers where id = $1`, [existing.id]);
  return existing;
}

export async function getActiveModel(ex: SqlExecutor): Promise<ActiveModelConfig | null> {
  const r = await ex.query(`select value from config where key = 'active_model'`);
  if (!r.rows.length) return null;
  const v = jsonValue(r.rows[0].value) as Partial<ActiveModelConfig> | null;
  if (!v || typeof v.provider_id !== "string" || typeof v.model_id !== "string") return null;
  return { provider_id: v.provider_id, model_id: v.model_id };
}

export async function setActiveModel(ex: SqlExecutor, active: ActiveModelConfig | null): Promise<void> {
  await ex.query(
    `insert into config (key, value, version) values ('active_model', $1::jsonb, 1)
     on conflict (key) do update set value = excluded.value, version = config.version + 1`,
    [JSON.stringify(active)],
  );
}

export async function clearActiveIfProvider(ex: SqlExecutor, providerId: string): Promise<void> {
  const active = await getActiveModel(ex);
  if (active?.provider_id === providerId) await setActiveModel(ex, null);
}

export interface AutocompleteModel {
  provider_id: string;
  model_id: string;
  label: string | null;
  context_window: number | null;
  supports_tool_calls: boolean | null;
}

export async function listModelsForAutocomplete(ex: SqlExecutor, query: string): Promise<AutocompleteModel[]> {
  const r = await ex.query(
    `select p.id as provider_id, m.model_id, m.label, m.context_window, m.supports_tool_calls
     from models_cache m join providers p on p.id = m.provider_id
     where p.enabled and m.model_id ilike $1
     order by m.model_id limit 25`,
    [`%${query}%`],
  );
  return r.rows.map((row) => ({
    provider_id: String(row.provider_id),
    model_id: String(row.model_id),
    label: row.label == null ? null : String(row.label),
    context_window: row.context_window == null ? null : Number(row.context_window),
    supports_tool_calls: row.supports_tool_calls == null ? null : Boolean(row.supports_tool_calls),
  }));
}

export interface CacheCounts {
  endpoint: number;
  catalog: number;
}

export async function cacheCounts(ex: SqlExecutor, providerId: string): Promise<CacheCounts> {
  const r = await ex.query(`select source, count(*)::int as n from models_cache where provider_id = $1 group by source`, [providerId]);
  const out: CacheCounts = { endpoint: 0, catalog: 0 };
  for (const row of r.rows) {
    if (row.source === "endpoint") out.endpoint = Number(row.n);
    if (row.source === "catalog") out.catalog = Number(row.n);
  }
  return out;
}

export async function replaceModels(ex: SqlExecutor, providerId: string, rows: DiscoverModelRow[]): Promise<void> {
  await ex.query(`delete from models_cache where provider_id = $1`, [providerId]);
  for (const row of rows) {
    await ex.query(
      `insert into models_cache
        (provider_id, model_id, label, context_window, output_window, supports_tool_calls, supports_reasoning, supports_structured_output, price_in, price_out, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [providerId, row.model_id, row.label, row.context_window, row.output_window, row.supports_tool_calls, row.supports_reasoning, row.supports_structured_output, row.price_in, row.price_out, row.source],
    );
  }
}
