# Postgres Required + Plain Table Names — Design

Status: approved by user on 2026-08-12
Author: brainstorm session (user + Droid)
Repo: /root/dev/projects/Ei

## 1. Vision and scope

The agent has been built "database optional": the Postgres world is opt-in via
`WORKFLOW_TARGET_WORLD`, every layer guards on `getExecutor()` returning `null`,
and the agent's tables carry an `ei_` prefix that exists for no reason the user
can see — the workflow engine already isolates itself in its own `workflow`
schema, and this agent has never been used in production with the `ei_*`
tables. This slice makes two unambiguous changes:

1. **Postgres is required.** The runtime always boots on
   `@workflow/world-postgres` with a hard fail-fast at boot if
   `WORKFLOW_POSTGRES_URL` is missing or unreachable (same shape as the
   existing fatal-gateway path — `process.exit(1)`, systemd restarts). The
   zero-DB local world and every "no Postgres → degrade silently" guard are
   deleted.
2. **The `ei_` table prefix is dropped.** The six tables are created under
   plain names (`providers`, `models_cache`, `config`, `schedules`,
   `schedule_runs`, `issues`) with their existing columns and FKs. Existing
   `ei_*` tables in any old database are **left orphaned** — never dropped,
   never renamed.

The `ei_` prefix in `WORKFLOW_POSTGRES_JOB_PREFIX=ei` is **not** in scope: it
is the workflow engine's job-key prefix, unrelated to the agent's table names,
and it stays.

**Out of scope:** deleting or migrating existing `ei_*` tables (orphaned,
per user), renaming `WORKFLOW_POSTGRES_URL`, schema-qualified table placement
(Approach B rejected — plain public-schema names, like today), touching gate
KV *keys* inside `config` (`health:last_report`, `lineage:pending`,
`active_model`, `catalog`), and any feature work.

## 2. Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Postgres posture | **Required** — always boot `@workflow/world-postgres`; fail fast at boot on missing/unreachable `WORKFLOW_POSTGRES_URL` | User-selected: "drop the zero-DB local world for the agent entirely and fail fast at boot". |
| Failure mode | `console.error` + `process.exit(1)` at boot (mirrors the existing fatal-gateway path; systemd restarts) | User-selected; consistent with repo behavior for unrecoverable boot conditions. |
| Table names | `ei_providers→providers`, `ei_models_cache→models_cache`, `ei_config→config`, `ei_schedules→schedules`, `ei_schedule_runs→schedule_runs`, `ei_issues→issues` | User-selected ("no need to prefix ei"). The workflow world already uses its own `workflow` schema, so plain public-schema names collide with nothing. |
| Old `ei_*` tables | **Left orphaned** — pure DDL rename of the CREATE statements, no drop, no ALTER RENAME, no data migration | User-selected ("never used ei in production"; zero deletion risk). |
| `getExecutor()` | Non-nullable: throws when `WORKFLOW_POSTGRES_URL` (and `DATABASE_URL` fallback) are both missing | Deletes the `if (!ex)` guards; the DB layer can no longer be "absent". |
| Runtime fallback | `resolveStepModel` keeps its try/catch → bundled `anthropic/claude-sonnet-5` fallback still answers when a *provider* lookup fails mid-flight | Only the DB-absent branch is removed; provider-level degradation stays. |
| Discrete assertions | `bootstrap.test.ts` "returns null when no database" case flips to `getExecutor()` **throwing** when no URL is configured; `resolveStepModel` still returns `null` on provider lookup failure | Tests must reflect the new contract. |
| Docs | `ENV.md` marks `WORKFLOW_POSTGRES_URL` required and deletes the `WORKFLOW_TARGET_WORLD` row; README drops "Postgres optional / degrades" language; evals documented as requiring Postgres | Keep docs honest with the new posture. |

## 3. Architecture

No structural changes — the same files, `lib/` and `agent/` layout, keep their
shapes. The changes are: one boot file, the DB layer contract, and a
repo-wide identifier rename.

```
packages/agent/
├── agent/agent.ts            # hardcode @workflow/world-postgres; required migrate + exit(1)
├── agent/schedules/*.ts      # drop `if (!ex) return` guards (dispatcher, health, lineage)
├── agent/channels/*.ts       # drop DB-absent branches (admin "/interact", discord run completions)
├── agent/tools/schedule_*.ts # drop `if (!ex) throw "scheduled jobs need Postgres"` guards
├── lib/db.ts                 # MIGRATE_SQL new names; getExecutor() non-null + getPostgresUrl()
├── lib/{providers,commands,models-dev,schedule-store,
│        schedule-dispatch,health,issues,lineage,gate}.ts  # rename ei_* → plain
└── tests/*.ts                # rename ei_* → plain in fixtures/SQL strings
```

### 3.1 DB layer contract (`lib/db.ts`)

- New exported helper `getPostgresUrl(env)` returns
  `env.WORKFLOW_POSTGRES_URL ?? env.DATABASE_URL`, and `getExecutor()` throws
  `new Error("WORKFLOW_POSTGRES_URL is required (set WORKFLOW_POSTGRES_URL or DATABASE_URL)")`
  when both are missing. Signature: `getExecutor(): SqlExecutor` (drop the
  `| null`).
- `MIGRATE_SQL` unchanged in structure, renamed identifiers only. Six
  `create table if not exists` statements under the plain names, FKs pointing
  at the new names (`models_cache.provider_id → providers(id)`,
  `schedule_runs.schedule_id → schedules(id)`,
  `issues.schedule_id → schedules(id)`). No statement touches `ei_*`.

### 3.2 Boot (`agent/agent.ts`)

```ts
// Before: opt-in condition + best-effort migrate.
void (async () => {
  const ex = getExecutor();
  if (ex) await migrate(ex).catch((err) => console.error("ei migrate failed", err));
})();

// After: required migrate, fail fast.
void (async () => {
  try {
    await migrate(getExecutor());
  } catch (err) {
    console.error("postgres boot failed", err);
    process.exit(1);
  }
})();
```

and:

```ts
experimental: {
  workflow: {
    world: "@workflow/world-postgres", // always; no WORKFLOW_TARGET_WORLD branch
  },
},
```

`migrate()` itself performs the connectivity check: with `create table if not
exists` statements it connects and round-trips within a few seconds, so a
missing/unreachable DB surfaces as a thrown error → exit(1) → systemd restart,
the same loop the gateway uses.

### 3.3 Guard removal sweep

Every `getExecutor()` caller currently tolerates `null`. All become direct,
since a missing DB throws at call time:

| File | Before | After |
| --- | --- | --- |
| `agent/schedules/dispatcher.ts` | `if (!ex) return;` + comment | direct `runDispatchCycle(getExecutor(), …)` |
| `agent/schedules/health.ts` | `if (!ex) return;` | direct |
| `agent/schedules/lineage.ts` | `if (!ex) return;` | direct |
| `agent/channels/admin.ts` | `if (!ex) return new Response("no database", …)` | direct |
| `agent/channels/discord.ts` (`message.completed`) | `if (ex) void completeRun(…)` | direct |
| `agent/tools/schedule_{create,update,delete,list,runs,trigger}.ts` | `if (!ex) throw new Error("scheduled jobs need Postgres …")` | direct |
| `lib/model.ts` `resolveStepModel` | `const ex = getExecutor(); if (!ex) return null;` | wrapped by the existing `try/catch` |

Deliberate exception: `channels/discord.ts` `message.completed` failure must
not take down the message-delivery path — the `completeRun` call stays
fire-and-forget with its existing `.catch(() => {})`, and its
`getExecutor()` call is wrapped so a DB hiccup there skips only the run-row
write, never the delivery. Same shape for the `/intake` route's
`from(address).send` path, which already handles errors in delivery.

## 4. Data model (renamed identifiers only)

```sql
create table if not exists providers ( …identical to ei_providers… );
create table if not exists models_cache (
  provider_id text not null references providers(id) on delete cascade, … );
create table if not exists config ( key text primary key, value jsonb not null, version bigint not null default 0 );
create table if not exists schedules ( …identical to ei_schedules… );
create table if not exists schedule_runs (
  schedule_id text not null references schedules(id) on delete cascade, … );
create table if not exists issues (
  schedule_id text not null references schedules(id) on delete cascade, … );
```

No column renames. No data migration. Old `ei_*` tables, if present, are
untouched by every statement the agent ever runs.

## 5. Flow (end to end)

1. Boot: `migrate(getExecutor())` connects and creates/verifies the six plain
   tables. Missing URL or unreachable DB → thrown → `console.error` +
   `process.exit(1)` → systemd restarts.
2. Every layer that needs the DB now calls `getExecutor()` and gets a
   non-null executor or a thrown error — none of the previous silent halts
   exist.
3. Runtime provider failure (only): `resolveStepModel` catches, returns
   `null`, and the model falls back to `anthropic/claude-sonnet-5` — the one
   intentional non-fatal degradation, unchanged.
4. Evals (`scripts/eval-ci.sh` → `bunx eve eval`) boot the full agent with
   `EVE_GATEWAY_DISABLED=1`; they now require Postgres like prod, which they
   already received under Doppler — documented, not code-changed.

## 6. Error handling

- **Missing URL**: `getExecutor()` throws with a clear message; boot exits 1.
- **Unreachable DB at boot**: `migrate()` throws; boot exits 1; systemd
  restarts (matches the gateway-fatal pattern).
- **DB unreachable mid-run (post-boot)**: schedule steps throw (visible in
  workflow run logs), provider resolution falls back to the bundled model;
  discord `message.completed` run-row writes fail silently per their existing
  fire-and-forget contract. No new silent half-states introduced beyond what
  exists today.
- **Unit tests without a DB**: unaffected — tests inject pg-mem executors and
  never call `getExecutor()`; `bootstrap.test.ts` is the single assertion to
  flip.

## 7. Testing

- **Unit (bun test, pg-mem, repo convention):**
  - `tests/db.test.ts` — migrate creates the six unprefixed tables with their
    FKs; a fresh pg-mem DB exercises the renamed DDL end to end.
  - `tests/bootstrap.test.ts` — `getExecutor()` throws when no URL is
    configured (replaces the "returns null when no database" case);
    `resolveStepModel` keeps returning `null` on provider lookup failure
    (covered by an existing or adjusted case).
  - All remaining test files — `commands`, `providers`, `registry`,
    `discovery`, `admin`, `schedule-store`, `dispatcher`,
    `channels-discord`, `issues`, `health`, `lineage`, `gate` — fixture SQL
    and describe strings updated `ei_*` → plain names.
- **Regression:** `bun run typecheck` + `bun test` fully green; `bun run
  build` (`eve build`) clean — the compiled manifest contains no table names,
  so discovery is unaffected.
- **Manual boot smoke:** `bunx eve start` without `WORKFLOW_POSTGRES_URL`
  exits non-zero with the error message; with a reachable URL it boots and
  the six tables exist.

## 8. Docs

- `docs/ENV.md`: `WORKFLOW_POSTGRES_URL` moves to **required** semantics
  ("Postgres connection string (workflow world + agent tables)");
  `WORKFLOW_TARGET_WORLD` row deleted.
- `README.md`: remove "postgres optional for local dev" and the
  "the agent boot and answers without Postgres" language; update the
  `ei_schedules`/`ei_schedule_runs`/`ei_issues` mentions to the plain names;
  note evals require Postgres.
- Spec + plan committed as before.

## 9. Success criteria

1. Fresh boot with `WORKFLOW_POSTGRES_URL` set creates exactly the six plain
   tables and zero `ei_*` references in any executed SQL.
2. Boot without the URL exits non-zero with a clear message; systemd restarts
   it (same observable behavior as a gateway fatal).
3. `bun run typecheck` + `bun test` green; the only behavior-assertion change
   is the DB-absence test flipping to a throw.
4. Existing `ei_*` tables in an old DB remain untouched (orphaned) — no drop,
   no rename, no data loss.
5. The agent still answers on the fallback model when a *provider* key is bad,
   and still records schedule runs and issues under the new names.
