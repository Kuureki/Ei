// models.dev api.json catalog: fetch, match, and map. Shape verified 2026-08-10.
import { jsonValue, type SqlExecutor } from "./db";
import type { DiscoverModelRow } from "./discovery";

export interface CatalogProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

export interface CatalogEntry {
  id: string;
  name?: string;
  api?: string;
  models?: Record<string, CatalogProviderModel>;
}

export type Catalog = Record<string, CatalogEntry>;

export const CATALOG_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeProviderKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Stable slash from a base URL (strip trailing /v1 or /).
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v\d*\/?$/, "").replace(/\/+$/, "");
}

export function matchCatalogEntry(
  catalog: Catalog,
  name: string,
  baseUrl: string,
): { id: string; entry: CatalogEntry } | null {
  const key = normalizeProviderKey(name);
  const direct = Object.keys(catalog).find((k) => normalizeProviderKey(k) === key);
  if (direct) return { id: direct, entry: catalog[direct] };
  let host = "";
  try {
    host = new URL(normalizeBaseUrl(baseUrl)).host;
  } catch {
    return null;
  }
  const byApi = Object.keys(catalog).find((k) => {
    const api = catalog[k].api;
    if (!api) return false;
    try {
      return new URL(api).host === host;
    } catch {
      return false;
    }
  });
  if (byApi) return { id: byApi, entry: catalog[byApi] };
  return null;
}

export function catalogModelsToRows(entry: CatalogEntry | undefined, providerId: string): DiscoverModelRow[] {
  void providerId;
  if (!entry?.models) return [];
  return Object.entries(entry.models).map(([id, m]) => ({
    model_id: id,
    label: m.name ?? null,
    context_window: m.limit?.context ?? null,
    output_window: m.limit?.output ?? null,
    supports_tool_calls: m.tool_call ?? null,
    supports_reasoning: m.reasoning ?? null,
    supports_structured_output: m.structured_output ?? null,
    price_in: m.cost?.input ?? null,
    price_out: m.cost?.output ?? null,
    source: "catalog" as const,
  }));
}

interface CatalogSnapshot {
  data: Catalog;
  fetched_at: number;
}

let memoryCache: CatalogSnapshot | null = null;

async function loadFromDb(ex: SqlExecutor | undefined): Promise<CatalogSnapshot | null> {
  if (!ex) return null;
  try {
    const r = await ex.query(`select value from ei_config where key = 'catalog'`);
    if (!r.rows.length) return null;
    const parsed = jsonValue(r.rows[0].value) as Partial<CatalogSnapshot> | null;
    if (!parsed || typeof parsed.data !== "object" || parsed.data === null || typeof parsed.fetched_at !== "number") return null;
    return { data: parsed.data as Catalog, fetched_at: parsed.fetched_at };
  } catch {
    return null;
  }
}

export async function getCatalog(
  opts: { ex?: SqlExecutor; fetchImpl?: typeof fetch; force?: boolean } = {},
): Promise<{ data: Catalog; fetchedAt: number; fresh: boolean }> {
  const f = opts.fetchImpl ?? fetch;
  const now = Date.now();
  if (memoryCache && now - memoryCache.fetched_at < CATALOG_TTL_MS && !opts.force) {
    return { data: memoryCache.data, fetchedAt: memoryCache.fetched_at, fresh: true };
  }
  const dbSnapshot = await loadFromDb(opts.ex);
  if (dbSnapshot && now - dbSnapshot.fetched_at < CATALOG_TTL_MS && !opts.force) {
    memoryCache = dbSnapshot;
    return { data: dbSnapshot.data, fetchedAt: dbSnapshot.fetched_at, fresh: true };
  }
  const res = await f(CATALOG_URL);
  if (!res.ok) {
    const fallback = memoryCache ?? dbSnapshot;
    if (fallback) return { data: fallback.data, fetchedAt: fallback.fetched_at, fresh: false };
    throw new Error(`models.dev fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as Catalog;
  memoryCache = { data, fetched_at: now };
  if (opts.ex) {
    try {
      await opts.ex.query(
        `insert into ei_config (key, value, version) values ('catalog', $1::jsonb, 1)
         on conflict (key) do update set value = excluded.value, version = ei_config.version + 1`,
        [JSON.stringify({ data, fetched_at: now })],
      );
    } catch {
      // persistence is best-effort; the in-memory cache still serves
    }
  }
  return { data, fetchedAt: now, fresh: true };
}
