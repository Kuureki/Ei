// PostgreSQL access for the agent's tables. Required at boot: getExecutor
// throws when no connection string is set, and migrate() runs at startup.
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

export function getPostgresUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.WORKFLOW_POSTGRES_URL ?? env.DATABASE_URL;
  if (!url) throw new Error("WORKFLOW_POSTGRES_URL is required (set WORKFLOW_POSTGRES_URL or DATABASE_URL)");
  return url;
}

export function getExecutor(): SqlExecutor {
  const url = getPostgresUrl();
  if (!shared || sharedUrl !== url) {
    shared?.end().catch(() => {});
    shared = createPool(url);
    sharedUrl = url;
  }
  return poolExecutor(shared);
}

export const MIGRATE_SQL = `
create table if not exists providers (
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
create table if not exists models_cache (
  provider_id text not null references providers(id) on delete cascade,
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
create table if not exists config (
  key text primary key,
  value jsonb not null,
  version bigint not null default 0
);
create table if not exists schedules (
  id text primary key,
  name text not null,
  prompt text not null,
  cadence text not null,
  every_minutes int,
  cron text,
  timezone text not null default 'UTC',
  enabled boolean not null default true,
  next_run_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_run_status text,
  last_run_output text,
  run_count bigint not null default 0,
  locked_until timestamptz,
  locked_by text,
  owner_discord_id text not null,
  guild_id text not null,
  dm_channel_id text not null,
  dm_thread_id text,
  tags jsonb not null default '[]'::jsonb,
  created_by text
);
create table if not exists schedule_runs (
  id text primary key,
  schedule_id text not null references schedules(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null,
  output text,
  error text,
  session_id text
);
create table if not exists issues (
  id          text primary key,
  schedule_id text not null references schedules(id) on delete cascade,
  kind        text not null,
  severity    text not null,
  status      text not null default 'open',
  root_cause  text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
`;

export async function migrate(ex: SqlExecutor): Promise<void> {
  await ex.query(MIGRATE_SQL);
}
