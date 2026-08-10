// Provider model discovery: endpoint /v1/models (source of truth) merged with models.dev catalog metadata.
import type { SqlExecutor } from "./db";
import { catalogModelsToRows, getCatalog, matchCatalogEntry } from "./models-dev";

export interface DiscoverModelRow {
  model_id: string;
  label: string | null;
  context_window: number | null;
  output_window: number | null;
  supports_tool_calls: boolean | null;
  supports_reasoning: boolean | null;
  supports_structured_output: boolean | null;
  price_in: number | null;
  price_out: number | null;
  source: "endpoint" | "catalog" | "both";
}

const NON_CHAT = /embedding|whisper|tts|speech|audio|image|rerank|moderation|dall-e|realtime|transcribe/i;

export function isChatCandidate(id: string): boolean {
  return !NON_CHAT.test(id);
}

export interface EndpointResult {
  models: string[] | null;
  error: string | null;
}

export async function fetchEndpointModels(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<EndpointResult> {
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const url = opts.baseUrl.replace(/\/+$/, "") + "/models";
  try {
    const res = await f(url, { headers });
    if (!res.ok) return { models: null, error: `GET ${url} -> ${res.status}` };
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(json.data)) return { models: null, error: "no data[] in /models response" };
    const ids = json.data.map((m) => String(m.id)).filter((id) => id && isChatCandidate(id));
    return { models: ids, error: null };
  } catch (err) {
    return { models: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function mergeDiscoveries(opts: { endpoint: string[] | null; catalog: DiscoverModelRow[] }): DiscoverModelRow[] {
  const catalogById = new Map(opts.catalog.map((r) => [r.model_id, r]));
  const merged = new Map<string, DiscoverModelRow>();
  for (const id of opts.endpoint ?? []) {
    const cat = catalogById.get(id);
    merged.set(id, {
      model_id: id,
      label: cat?.label ?? null,
      context_window: cat?.context_window ?? null,
      output_window: cat?.output_window ?? null,
      supports_tool_calls: cat?.supports_tool_calls ?? null,
      supports_reasoning: cat?.supports_reasoning ?? null,
      supports_structured_output: cat?.supports_structured_output ?? null,
      price_in: cat?.price_in ?? null,
      price_out: cat?.price_out ?? null,
      source: cat ? "both" : "endpoint",
    });
  }
  for (const cat of opts.catalog) {
    if (!merged.has(cat.model_id)) merged.set(cat.model_id, cat);
  }
  return [...merged.values()].sort((a, b) => a.model_id.localeCompare(b.model_id));
}

export interface DiscoverResult {
  rows: DiscoverModelRow[];
  endpointError: string | null;
}

export async function discoverModels(opts: {
  baseUrl: string;
  name: string;
  apiKey?: string;
  ex?: SqlExecutor;
  fetchImpl?: typeof fetch;
  forceCatalog?: boolean;
}): Promise<DiscoverResult> {
  const [endpoint, catalogResult] = await Promise.all([
    fetchEndpointModels({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, fetchImpl: opts.fetchImpl }),
    getCatalog({ ex: opts.ex, fetchImpl: opts.fetchImpl, force: opts.forceCatalog }),
  ]);
  const match = matchCatalogEntry(catalogResult.data, opts.name, opts.baseUrl);
  const catalogRows = match ? catalogModelsToRows(match.entry, match.id) : [];
  return { rows: mergeDiscoveries({ endpoint: endpoint.models, catalog: catalogRows }), endpointError: endpoint.error };
}
