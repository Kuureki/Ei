// PostgreSQL access for ei_* tables. Gracefully absent when no connection string is set.
import pg from "pg";

export interface QueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query(text: string, params?: unknown[]): Promise<QueryResultLike>;
}

// pg and pg-mem disagree on jsonb return types; normalize here.
export function jsonValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: Number(process.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE ?? 4) });
}

export function poolExecutor(pool: pg.Pool): SqlExecutor {
  return {
    query: async (text, params = []) => {
      const r = await pool.query(text, params as never[]);
      return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? null };
    },
  };
}

let shared: pg.Pool | null = null;
let sharedUrl: string | undefined;

export function getExecutor(): SqlExecutor | null {
  const url = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  if (!shared || sharedUrl !== url) {
    shared?.end().catch(() => {});
    shared = createPool(url);
    sharedUrl = url;
  }
  return poolExecutor(shared);
}

export const MIGRATE_SQL = `
create table if not exists ei_providers (
  id text primary key,
  name text unique not null,
  base_url text not null,
  key_env text not null,
  headers_json jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text
);
create table if not exists ei_models_cache (
  provider_id text not null references ei_providers(id) on delete cascade,
  model_id text not null,
  label text,
  context_window int,
  output_window int,
  supports_tool_calls boolean,
  supports_reasoning boolean,
  supports_structured_output boolean,
  price_in numeric,
  price_out numeric,
  source text not null,
  fetched_at timestamptz not null default now(),
  primary key (provider_id, model_id)
);
create table if not exists ei_config (
  key text primary key,
  value jsonb not null,
  version bigint not null default 0
);
`;

export async function migrate(ex: SqlExecutor): Promise<void> {
  await ex.query(MIGRATE_SQL);
}
