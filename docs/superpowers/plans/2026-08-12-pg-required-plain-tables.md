# Postgres Required + Plain Table Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Postgres mandatory (fail-fast boot) and drop the `ei_` prefix from all six agent tables.

**Architecture:** Pure rename of six `create table if not exists` statements plus every SQL string/comment that references them; the DB layer contract changes so `getExecutor()` never returns `null` (throws when no URL); boot hardcodes `@workflow/world-postgres` and exits 1 if migration fails; all "no Postgres → degrade silently" guards are deleted.

**Tech Stack:** TypeScript, eve ^0.31.3, pg (raw SQL via `SqlExecutor`), pg-mem for tests, Bun.

## Global Constraints

- Table name mapping is exact and total — everywhere these appear, rename: `ei_providers` → `providers`, `ei_models_cache` → `models_cache`, `ei_config` → `config`, `ei_schedules` → `schedules`, `ei_schedule_runs` → `schedule_runs`, `ei_issues` → `issues`.
- Do NOT rename, drop, or migrate existing `ei_*` tables in any database — they are left orphaned. No statement the agent runs may touch them.
- Do NOT touch `WORKFLOW_POSTGRES_JOB_PREFIX` (workflow engine job-key prefix, stays `ei`), or the KV keys inside `config`: `health:last_report`, `lineage:pending`, `active_model`, `catalog`.
- `getExecutor()` returns `SqlExecutor` (non-null); missing `WORKFLOW_POSTGRES_URL`/`DATABASE_URL` throws.
- Boot: `migrate(getExecutor())` in try/catch; on failure `console.error` + `process.exit(1)`.
- `experimental.workflow.world` hardcoded `"@workflow/world-postgres"`; the `WORKFLOW_TARGET_WORLD` branch is deleted.
- `resolveStepModel` keeps returning `null` (fallback to `anthropic/claude-sonnet-5`) on any runtime lookup failure — only the DB-absent fast path is removed.
- Tests: `bun test` (pg-mem, `test = bun test`), typecheck `tsc`, build `eve build`. Commands run from `packages/agent` unless noted.

---

### Task 1: Rename `ei_*` tables to plain names (lib + tests)

**Files:**
- Modify: `packages/agent/lib/db.ts` (DDL)
- Modify: `packages/agent/lib/{providers,models-dev,commands,schedule-store,schedule-dispatch,issues,health,lineage,gate}.ts`
- Modify: `packages/agent/tests/{db,commands,gate,issues,health,lineage,channels-discord}.test.ts`
- Test: `bun test` (all pg-mem suites exercise `migrate()` first, so the renamed DDL is covered by every file)

**Interfaces:**
- Consumes: nothing (self-contained).
- Produces: six tables `providers`, `models_cache`, `config`, `schedules`, `schedule_runs`, `issues` created by `migrate(ex)`; all lib SQL against the new names. `MIGRATE_SQL` export still exists with the same shape.

- [ ] **Step 1: Rename the DDL in `lib/db.ts`**

Replace the six `create table if not exists` statements and their FK references (keep columns identical, keep `MIGRATE_SQL` export name):

```sql
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
```

Also update the file's header comment from `// PostgreSQL access for ei_* tables. Gracefully absent when no connection string is set.` to:

```ts
// PostgreSQL access for the agent's tables. Required at boot: getExecutor
// throws when no connection string is set, and migrate() runs at startup.
```

- [ ] **Step 2: Rename the remaining lib SQL strings**

Apply the Global Constraints mapping to every `ei_<table>` occurrence in these files (each is a SQL string or a comment; also update line-1 comments like `// ei_issues adapter:` → `// issues adapter:`):

- `lib/providers.ts` — 10 occurrences (lines ~56–158): `ei_providers` ×4, `ei_config` ×2 (+`ei_config.version`), `ei_models_cache` ×4.
- `lib/models-dev.ts` — 3 occurrences (lines ~90–125): `ei_config` ×2 (+`ei_config.version`).
- `lib/commands.ts` — 4 occurrences (lines ~168–193): `ei_models_cache` ×1, `ei_providers` ×3.
- `lib/schedule-store.ts` — 15 occurrences; also the header comment `// ei_schedules + ei_schedule_runs adapter …` → `// schedules + schedule_runs adapter …`.
- `lib/schedule-dispatch.ts` — 2 occurrences (lines 25, 35).
- `lib/issues.ts` — 8 occurrences (lines ~57–122); header comment `// ei_issues adapter:` → `// issues adapter:`.
- `lib/health.ts` — 2 occurrences (lines 68, 73).
- `lib/lineage.ts` — 1 occurrence (line 71).
- `lib/gate.ts` — 4 occurrences (header comment + lines 7–15).

Do NOT rename the word `ei_config` inside quotes that are KV keys (`'active_model'`, `'catalog'`, `'health:last_report'`, `'lineage:pending'`) — those are data, not tables.

- [ ] **Step 3: Rename the test fixtures**

Apply the same mapping to `tests/db.test.ts` (all of it, plus the two `describe` names `"creates ei_* tables…"` → plain names), `tests/commands.test.ts` (2 SQL lines), `tests/gate.test.ts` (`describe("ei_config gates"…` → `describe("config gates"…` + 1 SQL line), `tests/issues.test.ts` (3 lines), `tests/health.test.ts` (3 lines), `tests/lineage.test.ts` (2 lines), `tests/channels-discord.test.ts` (2 lines).

- [ ] **Step 4: Run the full unit suite**

Run: `cd packages/agent && bun test`
Expected: 113 pass, 0 fail.

- [ ] **Step 5: Verify zero stray references remain**

Run: `rg -n "ei_(providers|models_cache|config|schedules|schedule_runs|issues)" packages/agent`
Expected: no matches (do not chase `ei_` alone — `WORKFLOW_POSTGRES_JOB_PREFIX` and `ei_config` KV keys are excluded by design).

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/lib packages/agent/tests
git commit -m "refactor: drop ei_ prefix from agent tables

Rename providers/models_cache/config/schedules/schedule_runs/issues in
DDL and all SQL strings. Existing ei_* tables are left orphaned; no data
migration. Per spec 2026-08-12.

Co-authored-by: factory-droid[bot] <138933558+factory-droid[bot]@users.noreply.github.com>"
```

---

### Task 2: Required Postgres — executor contract, guard sweep, fail-fast boot

**Files:**
- Modify: `packages/agent/lib/db.ts` (`getExecutor` + new `getPostgresUrl`)
- Modify: `packages/agent/lib/model.ts` (`resolveStepModel`)
- Modify: `packages/agent/agent/agent.ts` (boot + world)
- Modify: `packages/agent/agent/schedules/{dispatcher,health,lineage}.ts`
- Modify: `packages/agent/agent/channels/{admin,discord}.ts`
- Modify: `packages/agent/agent/tools/schedule_{create,update,delete,list,runs,trigger}.ts`
- Modify: `packages/agent/tests/bootstrap.test.ts`
- Test: `bun test` + `bun run typecheck`

**Interfaces:**
- Consumes: Task 1 table names.
- Produces: `getPostgresUrl(env?): string` (throws when no URL), `getExecutor(): SqlExecutor` (non-null), boot exits 1 on migrate failure, `@workflow/world-postgres` always active.

- [ ] **Step 1: Make `getExecutor()` non-nullable in `lib/db.ts`**

Replace the current `getExecutor` (and add `getPostgresUrl` above it):

```ts
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
```

- [ ] **Step 2: Write the failing contract test in `tests/bootstrap.test.ts`**

Append to the existing `describe("resolveStepModel")` block:

```ts
describe("db contract", () => {
  test("getPostgresUrl prefers WORKFLOW_POSTGRES_URL, falls back to DATABASE_URL", () => {
    expect(getPostgresUrl({ WORKFLOW_POSTGRES_URL: "pg://a", DATABASE_URL: "pg://b" })).toBe("pg://a");
    expect(getPostgresUrl({ DATABASE_URL: "pg://b" })).toBe("pg://b");
  });
  test("getPostgresUrl throws when no URL is configured", () => {
    expect(() => getPostgresUrl({})).toThrow(/WORKFLOW_POSTGRES_URL is required/);
    expect(() => getPostgresUrl()).toThrow(/WORKFLOW_POSTGRES_URL is required/);
  });
});
```

and add `getPostgresUrl` to the import from `../lib/db`:

```ts
import { getPostgresUrl } from "../lib/db";
```

- [ ] **Step 3: Run the new tests to see them fail (getPostgresUrl not exported yet)**

Run: `cd packages/agent && bun test tests/bootstrap.test.ts 2>&1 | tail -5`
Expected: FAIL — module/export resolution error.

- [ ] **Step 4: Update `resolveStepModel` in `lib/model.ts`**

Move `getExecutor()` inside the existing try/catch so DB absence degrades to the fallback model at runtime while the function still never returns anything but `LanguageModel | null`:

```ts
export async function resolveStepModel(env: Record<string, string | undefined>): Promise<LanguageModel | null> {
  try {
    const ex = getExecutor();
    const active = await getActiveModel(ex);
    if (!active) return null;
    const provider = await getProvider(ex, active.provider_id);
    if (!provider || !provider.enabled) return null;
    return buildLanguageModel(
      {
        provider_id: provider.id,
        base_url: provider.base_url,
        key_env: provider.key_env,
        headers_json: provider.headers_json,
        model_id: active.model_id,
      },
      env,
    );
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run the bootstrap tests**

Run: `cd packages/agent && bun test tests/bootstrap.test.ts`
Expected: PASS — the existing `"returns null when no database is configured"` case still passes (getExecutor now throws inside try → null), and the two new contract tests pass.

- [ ] **Step 6: Sweep the `if (!ex)` guards — schedules, tools, channels**

`agent/schedules/dispatcher.ts` — replace:

```ts
    const ex = getExecutor();
    if (!ex) return; // Postgres absent: nothing to dispatch; agent still boots.
    await waitUntil(
      runDispatchCycle(ex, {
```

with:

```ts
    const ex = getExecutor();
    await waitUntil(
      runDispatchCycle(ex, {
```

`agent/schedules/health.ts` and `agent/schedules/lineage.ts` — delete the same `if (!ex) return; // Postgres absent: …` line after `const ex = getExecutor();` in each.

Six tools in `agent/tools/` (`schedule_create.ts`, `schedule_update.ts`, `schedule_delete.ts`, `schedule_list.ts`, `schedule_runs.ts`, `schedule_trigger.ts`) — replace `if (!ex) throw new Error("scheduled jobs need Postgres (WORKFLOW_POSTGRES_URL)");` with nothing (keep `const ex = getExecutor();`).

`agent/channels/admin.ts` — replace:

```ts
      const ex = getExecutor();
      if (!ex) return new Response("no database", { status: 200 }); // config surface unavailable; the agent still runs on the fallback model
      await migrate(ex).catch(() => {});
```

with:

```ts
      const ex = getExecutor();
      await migrate(ex).catch(() => {});
```

`agent/channels/discord.ts` — two spots. In `"message.completed"`:

```ts
      if (addr.scheduleRunId) {
        const ex = getExecutor();
        if (ex) {
          void completeRun(ex, addr.scheduleRunId, {
            status: "succeeded",
            output: (eventData.message ?? "").slice(0, 4000),
            sessionId: ctx?.session?.id,
          }).catch(() => {});
        }
      }
```

becomes:

```ts
      if (addr.scheduleRunId) {
        // DB unavailable here must not take down message delivery: skip only
        // the run-row write. `getExecutor()` throws instead of returning null,
        // so it is caught and the turn still completes.
        try {
          void completeRun(getExecutor(), addr.scheduleRunId, {
            status: "succeeded",
            output: (eventData.message ?? "").slice(0, 4000),
            sessionId: ctx?.session?.id,
          }).catch(() => {});
        } catch {
          // no run row this turn; delivery continues
        }
      }
```

In `"turn.failed"`:

```ts
      const addr = channel.continuation ? decodeToken(channel.continuation.token) : null;
      if (!addr?.scheduleRunId) return;
      const ex = getExecutor();
      if (!ex) return;
      void completeRun(ex, addr.scheduleRunId, {
```

becomes:

```ts
      const addr = channel.continuation ? decodeToken(channel.continuation.token) : null;
      if (!addr?.scheduleRunId) return;
      void completeRun(getExecutor(), addr.scheduleRunId, {
```

(the `completeRun` promise is already handled with `.catch(() => {})` below).

- [ ] **Step 7: Fail-fast boot + hardcoded world in `agent/agent.ts`**

Replace the boot block:

```ts
// Boot migration is idempotent and best-effort; the agent must boot without Postgres.
void (async () => {
  const ex = getExecutor();
  if (ex) await migrate(ex).catch((err) => console.error("ei migrate failed", err));
})();
```

with:

```ts
// Postgres is required. migrate() connects and creates/verifies the tables;
// failure here is fatal so systemd restarts (same shape as the gateway fatal).
void (async () => {
  try {
    await migrate(getExecutor());
  } catch (err) {
    console.error("postgres boot failed", err);
    process.exit(1);
  }
})();
```

And replace the `experimental.workflow` block:

```ts
  experimental: {
    workflow: {
      // Production: set WORKFLOW_TARGET_WORLD=@workflow/world-postgres (and
      // WORKFLOW_POSTGRES_URL). Defaults to the zero-DB local world.
      world:
        process.env.WORKFLOW_TARGET_WORLD === "@workflow/world-postgres"
          ? "@workflow/world-postgres"
          : "@workflow/world-local",
    },
  },
```

with:

```ts
  experimental: {
    workflow: {
      world: "@workflow/world-postgres", // always; Postgres is required (§ spec 2026-08-12)
    },
  },
```

- [ ] **Step 8: Typecheck and run the full suite**

Run: `cd packages/agent && bun run typecheck && bun test`
Expected: typecheck clean; 113+ pass, 0 fail.

- [ ] **Step 9: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent
git commit -m "feat: require postgres and fail fast at boot

getExecutor no longer returns null (throws without WORKFLOW_POSTGRES_URL),
the agent always boots @workflow/world-postgres with a mandatory migrate
that exits 1 on failure, and every silent DB-absence guard is removed.
resolveStepModel still falls back to the bundled model on runtime lookup
failure. Per spec 2026-08-12.

Co-authored-by: factory-droid[bot] <138933558+factory-droid[bot]@users.noreply.github.com>"
```

---

### Task 3: Docs + final verification

**Files:**
- Modify: `docs/ENV.md`
- Modify: `README.md`
- Test: full repo verification

**Interfaces:**
- Consumes: everything from Tasks 1–2.

- [ ] **Step 1: Update `docs/ENV.md`**

Secrets table — change:

```
| `WORKFLOW_POSTGRES_URL` | Postgres connection string (workflow world + ei_* tables) |
```

to:

```
| `WORKFLOW_POSTGRES_URL` | Postgres connection string (required; workflow world + agent tables) |
```

Non-secret table — delete the row:

```
| `WORKFLOW_TARGET_WORLD` | `@workflow/world-postgres` for the durable world |
```

(keep `WORKFLOW_POSTGRES_JOB_PREFIX` and `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` rows).

- [ ] **Step 2: Update `README.md`**

- Prerequisites section, replace:

```
- Postgres reachable via `WORKFLOW_POSTGRES_URL` for the durable world and
  the `ei_*` tables (optional for local dev; the agent boots without it on
  the zero-DB local world).
```

with:

```
- Postgres reachable via `WORKFLOW_POSTGRES_URL` (required — the agent fails
  fast at boot without it). The same database hosts the workflow world
  (`workflow` schema) and the agent's tables (`providers`, `models_cache`,
  `config`, `schedules`, `schedule_runs`, `issues`).
```

- Operations section, replace `the agent itself degrades when Postgres or the active provider is unavailable` with `the agent answers on the fallback model when the active provider is unavailable` (keep the gateway-reconnect sentence).
- Scheduled jobs section: `ei_schedules` + `ei_schedule_runs` → `schedules` + `schedule_runs`; `ei_schedule_runs` in "asks the agent to report" sentence → `schedule_runs`.
- Self-healing & evolution section: `ei_issues` → `issues`.
- Workspace layout row for the agent package: no change needed (no table names).

- [ ] **Step 3: Full verification**

Run:

```bash
cd /root/dev/projects/Ei && bun run typecheck && cd packages/agent && bun test && bun run build
```

Expected: typecheck clean; all tests pass (113+); `eve build` completes with the manifest showing `schedules: [dispatcher, health, lineage]` and diagnostics 0/0 (same as before — the build doesn't reference table names).

- [ ] **Step 4: Manual boot smoke (no Postgres)**

Run: `cd packages/agent && bunx eve start` with `env -u WORKFLOW_POSTGRES_URL -u DATABASE_URL`
Expected: exits non-zero within seconds with `console.error` output containing `postgres boot failed` (missing URL thrown by `getPostgresUrl`). Do not run this against a real Doppler environment.

- [ ] **Step 5: Commit**

```bash
cd /root/dev/projects/Ei
git add docs/ENV.md README.md
git commit -m "docs: postgres required, plain table names

ENV.md marks WORKFLOW_POSTGRES_URL required and drops WORKFLOW_TARGET_WORLD;
README reflects the plain table names and fail-fast posture. Per spec
2026-08-12.

Co-authored-by: factory-droid[bot] <138933558+factory-droid[bot]@users.noreply.github.com>"
```

---

## Self-review notes (write-only, for the planner)

- Spec coverage: §2 table names → Task 1; §2 posture/exit/guards → Task 2; §2 docs → Task 3; §5 flow → Task 2 steps 4/7 (boot flow; fallback preserved via model.ts try/catch, verified in Task 2 step 5); §6 error handling → Task 2 steps 4/6/7; §7 testing → Task 1 step 4, Task 2 steps 2–5/8, Task 3 steps 3–4; §8 docs → Task 3.
- Placeholders: none.
- Type consistency: `getPostgresUrl(env?)` and non-null `getExecutor(): SqlExecutor` used consistently across Tasks 2–3; `resolveStepModel` returns `Promise<LanguageModel | null>` unchanged.
