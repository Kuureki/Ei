# BYOK Provider Registry + Ops Layer — Design

Status: approved by user on 2026-08-10
Author: brainstorm session (user + Droid)
Repo: /root/dev/projects/Ei

## 1. Vision and scope

The memory-core agent (slice 1) is live. This slice adds a self-service model
layer and ops surface on top of it:

- A **BYOK provider registry**: register any number of OpenAI-compatible
  endpoints (base URL + Doppler-injected key reference), discover their models
  the Hermes way — directly from the endpoint's `/v1/models` — enriched by the
  [models.dev](https://models.dev) open catalog.
- **Live model switching** with no restart: pick an active provider+model
  (`/provider use`), applied on the next model step by a dynamic resolver.
- **Native Discord slash commands** (registered, ephemeral, owner-gated,
  autocomplete, one modal) for the registry.
- **One service**: the Discord gateway connector now runs inside the eve
  process. No second unit to maintain.
- **Strict Doppler**: every secret lives in Doppler; all processes run under
  `doppler run --`; no `.env` files anywhere; the repo contains no secrets.

Explicitly **out of scope** for this slice (later, not built here):
- Per-channel model override (`/provider use --channel`).
- Configurable surfaces beyond the provider registry (memory/capture settings,
  status/diagnostics commands).
- Multi-process workers. The Postgres world already supports SQL-backed
  queuing; raising `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` is the documented
  lever, but no worker machinery ships now.
- Non-OpenAI-compatible native providers as registry entries (the built-in
  gateway fallback model remains the always-on baseline).

## 2. Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Command style | **Native Discord slash commands** (registered, options, autocomplete, ephemeral, one modal) | User-selected for polish; interaction lifecycle handled in the agent. |
| V1 surface | Provider registry only (`/provider add/edit/remove/list/test/refresh/use`) | User-selected; the registry includes discovery + active-model selection. |
| Config effect | **Live, no restart** | User-selected; eve resolves the model per step and reads config per request. Model switches re-ingest once (prompt cache reset) — accepted. |
| Scale target | **Snappy personal agent**: one owner, many channels/threads; latency and per-session efficiency, not raw parallelism | User-selected. |
| Discovery sources | Endpoint `/v1/models` **plus** models.dev `api.json` | User-added (`you can also see models.dev`): endpoint shows what a provider actually serves; models.dev supplies context windows, capabilities, pricing, and works for endpoints that hide `/models`. |
| Secrets | **Doppler, strict**: prod and dev both under `doppler run --`; no `.env` files; repo holds no secrets | User-selected. Provider keys are referenced by env name, never stored. |
| Active model | Global default via the registry (`/provider use <model>`); per-channel override deferred | User-selected. Resolution reads `ei_config.active_model`; per-channel override deferred. |
| Deployment | **One service**: gateway runs in-process with the agent | User-selected ("same service rather than two different services to maintain"). |
| Architecture | Agent is the brain; the connector is a thin Discord socket client that feeds loopback routes | Preserves the accepted slice-1 architecture; keeps Discord REST calls in one place. |

## 3. Architecture

```
Your server (closed, no inbound)
└── one process: eve runtime (Node 24+, durable execution, PostgreSQL world)
    ├── Eve agent (Nitro server, custom channels)
    │   ├── agent/channels/discord.ts   POST /intake   (messages, unchanged)
    │   ├── agent/channels/admin.ts     POST /interact (interactions, new)
    │   ├── lib/gateway/                in-process Discord gateway client (moved from packages/connector)
    │   ├── lib/providers.ts            registry CRUD, discovery, model construction
    │   ├── lib/commands.ts             interaction → command dispatch
    │   ├── lib/migrate.ts              idempotent schema bootstrap at boot
    │   ├── agent.ts                    defineDynamic model (step.started) + guarded gateway boot
    │   └── evals/                       model-switch scenarios
    └── single systemd unit ei.service   ExecStart: doppler run -- bunx eve start
```

### 3.1 Gateway in-process

- The connector code (verified: pure global `WebSocket` + `fetch`, no `Bun.*`
  API usage) moves to `packages/agent/lib/gateway/` and boots from a guarded
  side-effect at the top of `agent.ts`:
  `if (shouldStartGateway()) startGateway()`. The guard reads an env flag
  (`EVE_GATEWAY_DISABLED=1`) so `eve eval` and tests never open Discord
  connections.
- The gateway POSTs inbound events to the agent's own loopback routes — the
  same `x-eve-connector-secret`-gated pattern as today:
  - `MESSAGE_CREATE` → `POST http://127.0.0.1:${PORT}/intake`
  - `INTERACTION_CREATE` (type 2 command, 4 autocomplete, 5 modal submit) →
    `POST http://127.0.0.1:${PORT}/interact`
- `EVE_RUNTIME_URL` remains an optional override (default loopback). Re-extracting
  the gateway to a separate service later is config-only: point
  `EVE_RUNTIME_URL` at the agent and run the same gateway code elsewhere.
- The routes stay the single canonical ingestion interface: unchanged channel
  handlers, `curl`-testable, and the future extraction path.
- Gateway failures are contained: reconnect with resume/backoff (already
  implemented); an unhandled gateway error crashes the process so systemd
  restarts the whole service consistently.
- One process means one health check, one journal, one env surface.

### 3.2 Interaction flow (all loopback/local, all < 3 s)

1. Gateway receives `INTERACTION_CREATE` → forward to `POST /interact` with
   `x-eve-connector-secret`.
2. `agent/channels/admin.ts` verifies the secret, then the owner gate
   (`interaction.user.id === AGENT_OWNER_DISCORD_ID`).
3. Dispatch:
   - Command (type 2) / modal submit (type 5): POST `type: 5` deferred ACK with
     `EPHEMERAL` flag to `/interactions/{id}/{token}/callback`, run the command
     (DB, discovery, test call), then PATCH
     `/webhooks/{app_id}/{interaction_token}/messages/@original` with the
     result text. Interaction callbacks carry their own token in the URL and do
     not require the bot token.
   - Autocomplete (type 4): POST `type: 8` with up to 25 choices built **from
     the cached catalog only** (no network in the hot path); on timeout or
     errors, respond with empty choices (Discord clears the suggestions).

## 4. Data model

Same Postgres as the workflow world (`WORKFLOW_POSTGRES_URL`), own `ei_*`
tables, bootstrapped by idempotent `CREATE TABLE IF NOT EXISTS` in
`lib/migrate.ts` at agent boot.

```sql
create table ei_providers (
  id                text primary key,          -- slug of name
  name              text unique not null,      -- lookup + display
  base_url          text not null,             -- e.g. https://api.openai.com/v1
  key_env           text not null,             -- Doppler var name, never the value
  headers_json      jsonb,                     -- optional; "${env:NAME}" refs supported
  enabled           boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_tested_at    timestamptz,
  last_test_ok      boolean,
  last_test_error   text
);

create table ei_models_cache (
  provider_id                text not null references ei_providers(id) on delete cascade,
  model_id                  text not null,
  label                     text,              -- human name (models.dev)
  context_window            int,
  output_window             int,
  supports_tool_calls       boolean,
  supports_reasoning        boolean,
  supports_structured_output boolean,
  price_in                  numeric,
  price_out                 numeric,
  source                    text not null,     -- 'endpoint' | 'catalog' | 'both'
  fetched_at                timestamptz not null default now(),
  primary key (provider_id, model_id)
);

create table ei_config (
  key      text primary key,
  value    jsonb not null,
  version  bigint not null default 0           -- bumped on every write
);
```

`ei_config` rows:
- `active_model` → `{"provider_id": "...", "model_id": "..."}` (null/absent = use
  gateway fallback).
- `catalog` → `{"fetched_at": ..., "data": <models.dev api.json>}` — cached so
  the catalog survives restarts and is not refetched per command.

## 5. Discovery (Hermes-style merge)

1. **Endpoint**: `GET {base_url}/models` with Bearer when a key is available or
   set. Map `data[]` model ids. Tolerate 401/404/5xx — a provider may hide its
   catalog; that yields zero endpoint models, not an error.
2. **Catalog**: `GET https://models.dev/api.json`, cached in `ei_config.catalog`
   with a 24 h TTL, forced by `/provider refresh`. Match to the provider by
   name (case-insensitive models.dev provider id, e.g. `groq`) or base-URL
   host; enrich context windows, capability flags, pricing.
3. Merge by `model_id` into `ei_models_cache`: endpoint wins for existence,
   catalog enriches metadata; `source` records origin.

Triggers: `/provider add` (after insert), `/provider edit` (when `base_url`
changes), `/provider refresh` (always, forces catalog refresh). Failures leave
existing cache rows intact and are reported in the command reply.

## 6. Dynamic model resolution

`agent.ts`:

```ts
model: defineDynamic({
  fallback: "anthropic/claude-sonnet-5", // gateway model; anchors build metadata
  events: {
    "step.started": async (_event, ctx) => {
      const active = await getActiveModel();      // ei_config.active_model + provider row
      if (!active) return null;                    // fallback
      const key = process.env[active.key_env];
      if (!key) return null;                       // secret not provisioned → fallback
      return createOpenAI({
        name: active.provider_id,
        baseURL: active.base_url,
        apiKey: key,
        headers: renderHeaders(active.headers_json),
      }).chat(active.model_id);
    },
  },
}),
```

Constraints honored from eve's documented contract:
- Session/turn selections must be serializable model-id strings; a **live AI SDK
  LanguageModel may only be returned from `step.started`** — exactly what this
  design does, since BYOK endpoints are not gateway-routed ids.
- Failures degrade, never fail the turn: any resolver throw or missing key
  returns `null` → eve falls back to `fallback`.
- Prompt caches are per model; switching models re-ingests the conversation
  once. Accepted (user approved live switching).

Efficiency (hot path):
- The resolver reads `ei_config.active_model` (one indexed PK read) and the
  provider row (one PK read) per step; no network.
- The `createOpenAI(...).chat(...)` instance is rebuilt only when
  `active_model`/provider content changes (compare cached blob keyed by
  `version` + `updated_at`).

## 7. Command surface

All commands: owner-gated, ephemeral, registered as guild commands
(`PUT /applications/{app}/guilds/{guild}/commands` for instant availability —
no global 1 h cache), by `scripts/register-commands.mjs` run via
`doppler run --`.

| Command | Kind | Behavior |
| --- | --- | --- |
| `/provider add` | modal (name, base_url, key_env, headers optional) | Insert row, run discovery, reply with model count. If `key_env` unset in env: reply `doppler secrets set PROVIDER_<NAME>_API_KEY=...` |
| `/provider list` | command | name, enabled, base_url, key set/unset, endpoint vs catalog model counts, last test |
| `/provider edit <name>` | command, options `[base_url, key_env, enabled]` | Update; re-run discovery if `base_url` changed |
| `/provider remove <name>` | command | Delete + cascade models cache; clear `active_model` if it referenced this provider (fallback resumes) |
| `/provider test <name>` | command | One-token completion against the lowest `model_id` in the cache (the active model if it belongs to this provider); record `last_tested_*`; reply ok/fail + latency |
| `/provider refresh <name>` | command | Re-fetch `/v1/models` + force catalog refresh; report new counts |
| `/provider use <model>` | command, autocomplete | Choices from `ei_models_cache` union across enabled providers, labeled `provider/model — ctx, tool calls, price`. Sets `active_model`, bumps version; applies next model step |

Command outputs are plain text (no embeds) rendered by the interaction
follow-up; autocomplete choices are model ids with labels.

## 8. Secrets and environment (Doppler)

Strict mode: no `.env` anywhere; `.env.example` files are deleted; the README
becomes the reference env table plus a `doppler secrets set` cheat sheet.
Every invocation runs under `doppler run --`.

| Secret (Doppler) | Used by | Notes |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | gateway + Discord REST | replies/typing/interaction follow-ups |
| `DISCORD_APP_ID` | interaction URLs, registration | |
| `AGENT_OWNER_DISCORD_ID` | owner gate | |
| `AGENT_OWNER_GUILD_ID` | command registration target | |
| `EVE_CONNECTOR_SECRET` | loopback route gate (`x-eve-connector-secret`) | |
| `INNERNET_KEY` | memory connection | |
| `WORKFLOW_POSTGRES_URL` | workflow world | plus optional `…_JOB_PREFIX`, `…_WORKER_CONCURRENCY` |
| Whisper key (if used) | transcribe tool | |
| `PROVIDER_<NAME>_API_KEY` | one per BYOK provider | name chosen at `/provider add`; value only ever set via `doppler secrets set` |

Non-secret (also in Doppler config, not in git):

| Variable | Notes |
| --- | --- |
| `PORT` | eve server port (loopback base for the gateway) |
| `WORKFLOW_TARGET_WORLD` | `@workflow/world-postgres` |
| `EVE_RUNTIME_URL` | optional loopback override for future gateway extraction |
| `EVE_GATEWAY_DISABLED` | set for `eve eval` / tests |

Provider keys never transit Discord, never sit in Postgres (only the env var
*name* is stored), and never appear in the repo. `/provider add` does not ask
for key values.

## 9. Deployment and operations

One unit:

```ini
# /etc/systemd/system/ei.service
[Service]
ExecStart=/usr/local/bin/doppler run -- bunx eve start
WorkingDirectory=/opt/ei/packages/agent
Restart=on-failure
```

Runbook (one service): doppler project setup (`doppler setup --project ei`
with dev/prod configs) → set secrets → `doppler run -- bun scripts/register-commands.mjs`
→ enable unit → `journalctl -u ei -f`. Adding a provider = `/provider add` in
Discord + `doppler secrets set PROVIDER_<NAME>_API_KEY=...` + `/provider test`.
Upgrade = pull + `bun install` + `bun run build` + restart the unit.

`packages/connector` is deleted; its gateway code lives in
`packages/agent/lib/gateway/`.

## 10. Testing

- **Unit** (bun test, agent package): discovery-merge pure functions with a
  fixture slice of `api.json` and a stubbed endpoint; `${env:NAME}` header/key
  interpolation; command dispatch routing; gateway `INTERACTION_CREATE` parsing
  and forwarding (stub `fetch`).
- **Evals** (backlog continues): `provider-switch-active` (probe "what model
  are you using?" reflects the active provider/model), `provider-config-persists`
  (restart keeps the active selection). Existing memory evals remain in the
  backlog. `scripts/eval-ci.sh` sets `EVE_GATEWAY_DISABLED=1` so evals never
  boot the gateway.
- **Manual E2E** (real keys, in README): register commands, `/provider add`,
  `/provider list`, `/provider test`, `/provider use`, confirm the reply model
  changes.

## 11. Error handling

- Resolver: any failure → `null` → gateway fallback. Never a failed turn.
- Discovery: endpoint 401/404 tolerated; network errors reported in the reply;
  prior cache rows survive.
- `/provider test`: unset `key_env` → clear message telling the user to run
  `doppler secrets set`; failed completion → `last_test_error` + reply.
- Autocomplete: on slow catalog or errors, empty choices (Discord clears the
  picker) — never a crash.
- Gateway: resume/backoff built in; process failure → systemd restarts.
- Secrets: key values never logged; env *names* may appear in replies.

## 12. Known constraints and risks

- **step.started only**: live LanguageModels for BYOK endpoints can only be
  returned at step scope (eve contract). Cost: one resolver run per model step
  (mitigated to two index reads) and a one-time re-ingest when the active model
  changes (accepted).
- **Registration latency**: guild-scoped commands apply instantly; no global
  cache. `scripts/register-commands.mjs` must run after deploy.
- **3 s interaction window**: covered by deferred ACKs; autocomplete answered
  from the cache only.
- **models.dev drift**: catalog is a snapshot service; `/provider refresh`
  forces a refetch. Endpoint discovery is the source of truth for existence.

## 13. Explicitly deferred

- Per-channel active-model override.
- Config surfaces beyond the provider registry (memory/capture settings,
  status/diagnostics).
- Multi-process workers (`WORKFLOW_POSTGRES_WORKER_CONCURRENCY` documented only).
- Gateway extraction to a separate service (config-only path already designed).
