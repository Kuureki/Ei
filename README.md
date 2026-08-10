# Ei — personal agent memory core

A self-hosted personal memory agent built on [eve](https://eve.dev). You talk
to it in Discord (server or DM); it captures durable knowledge into
[innernet](https://innernet.live/) and answers queries from memory with
citations. Files arrive as text, code, documents, images, or voice memos, and
everything is queryable later — through the model you choose: a built-in
BYOK provider registry manages an unlimited set of OpenAI-compatible providers
and switches the active model live, no restarts.

## 1. Architecture

One process. The eve agent (Node 24) hosts:

- **Custom channels** — `POST /intake` (messages) and `POST /interact`
  (commands/autocomplete/modals), both guarded by the shared connector secret.
- **The Discord gateway** — `packages/agent/lib/gateway/`, a zero-dependency
  `WebSocket` client (heartbeat/resume/backoff) connected **out** to
  `wss://gateway.discord.gg`. It filters to the single owner, downloads
  attachments, and forwards to the in-process loopback routes.
- **Provider registry + ops** — `ei_providers`, `ei_models_cache`, and
  `ei_config` tables in the same Postgres as the workflow world. Slash
  commands manage providers, model discovery (`/v1/models` + models.dev),
  testing, refresh, and the active model.
- **Dynamic model resolution** — a `defineDynamic` fallback
  (`anthropic/claude-sonnet-5`) with a `step.started` resolver that returns a
  live `@ai-sdk/openai` model built from the active provider row. Failures
  degrade to the fallback; the agent always answers.

There is **no Docker** and **no public inbound endpoint**: the gateway
connects out to Discord, and the agent serves on `127.0.0.1` guarded by the
shared secret.

Design: `docs/superpowers/specs/2026-08-10-byok-provider-registry-design.md`
(implementation plan:
`docs/superpowers/plans/2026-08-10-byok-provider-registry.md`). The original
memory-core design is in
`docs/superpowers/specs/2026-08-10-personal-agent-memory-core-design.md`.

## 2. Prerequisites

- Node 24+ (the eve server runtime).
- Bun 1.3.14 (package manager / task runner / tooling).
- Doppler CLI with a project (dev and prod configs).
- Postgres reachable via `WORKFLOW_POSTGRES_URL` for the durable world and
  the `ei_*` tables (optional for local dev; the agent boots without it on
  the zero-DB local world).

## 3. Setup

```bash
git clone <url> Ei && cd Ei
bun install
doppler setup --project ei        # picks your dev/prod configs
```

Set the environment values from `docs/ENV.md` (secrets + non-secrets) with
`doppler secrets set <NAME>=<value>` or `doppler import`. Tables migrate
automatically at boot — nothing to run.

## 4. Run

Dev (hot reload, no gateway unless envs are set):

```bash
doppler run -- bun run --cwd packages/agent dev
```

Production, one systemd unit for the whole service:

```ini
# /etc/systemd/system/ei.service
[Unit]
Description=ei personal agent (eve + discord gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/ei/packages/agent
ExecStart=/usr/local/bin/doppler run -- bunx eve start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Health: `curl http://127.0.0.1:3000/eve/v1/health`. `POST /intake` and
`POST /interact` return `403` without the connector secret.

## 5. Register commands

```bash
doppler run -- bun scripts/register-commands.ts          # PUT the provider command
doppler run -- bun scripts/register-commands.ts --dry-run # preview payload
doppler run -- bun scripts/register-commands.ts --list    # current registration
```

Registers one guild-scoped `/provider` command with subcommands `add`, `list`,
`edit`, `remove`, `test`, `refresh`, `use` (autocomplete on the model option),
using `AGENT_OWNER_GUILD_ID`.

## 6. Add a provider

1. `/provider add` → fill the modal (name, OpenAI-compatible base URL, the
   Doppler secret **name** such as `PROVIDER_GROQ_API_KEY`, optional headers
   JSON with `${env:NAME}` refs). The endpoint's `/v1/models` is fetched and
   merged with models.dev metadata; unmatched extra headers/fields are ignored
   safely.
2. Set the actual value: `doppler secrets set PROVIDER_GROQ_API_KEY=sk-...`.
3. `/provider test <name>` — one-token completion against the provider.
4. `/provider refresh <name>` — re-discover models from `/v1/models` +
   models.dev.
5. `/provider use <model>` — autocomplete from the live catalog; the active
   model applies from your **next message** (no restart).

`/provider list` shows each provider's key status (set/unset), cached model
counts by source, and marks the active one.

## 7. Operations

- Logs: `journalctl -u ei -f`.
- Upgrade: `git pull && bun install && doppler run -- bunx eve build` then
  restart the unit.
- The gateway logs fatal close codes and exits for systemd to restart; the
  agent itself degrades when Postgres or the active provider is unavailable.

## 8. Testing

```bash
cd packages/agent
bun test                 # unit tests (pg-mem backed, no network)
bun run typecheck        # strict tsc
../scripts/eval-ci.sh    # eve evals (needs Doppler keys; sets EVE_GATEWAY_DISABLED)
```

## 9. Security

- Keys are referenced **by name** only — `ei_providers.key_env` stores the
  Doppler var name, never the value; plaintext never lands in Postgres,
  Discord, or the repo.
- Command replies are ephemeral; outbound replies never ping
  (`allowed_mentions: { parse: [] }`).
- Owner gates at both layers: the loopback secret header **and** the Discord
  user id.
- No public inbound endpoint (gateway connects out).

## 10. Scaling / future

- `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` tunes the queue worker pool.
- `EVE_RUNTIME_URL` allows re-extracting the gateway out-of-process later
  without code changes.
- Per-channel model overrides and additional command surfaces are deferred
  (see the design spec).

## Workspace layout

Bun-managed monorepo. `bun` is the package manager and task runner; the eve
server executes under Node 24 (eve's engine). Production runs `eve start`
(its loader resolves framework bundles; running `node .output/server/index.mjs`
directly fails on Bun's `.bun/` store layout).

| Path | Package | What it is |
| --- | --- | --- |
| `packages/agent` | `@ei/agent` | Eve app: channels (`/intake`, `/interact`), provider registry + ops (`lib/`), tools, instructions, evals |
| `packages/shared` | `@ei/shared` | Pure helpers (`nets`, `discord-util`) built to `dist/` |
| `scripts` | — | `register-commands.ts`, `eval-ci.sh`, `check-innernet-manifest.sh` |

Root scripts: `dev:agent`, `build:agent`, `start:agent`, `typecheck`,
`build:shared`.

## Discord prerequisites

- Developer portal → your application → **Bot**: enable *Message Content
  Intent* (required for the gateway to receive message text).
- Invite URL with scope `bot` + `applications.commands` and basic text
  permissions.
- Put your Discord user id in `AGENT_OWNER_DISCORD_ID` and your server id in
  `AGENT_OWNER_GUILD_ID`.

## Error handling (what's built in)

- Non-owner messages and interactions are dropped before either route.
- Attachments > 10 MB are rejected with a one-line notice.
- Replies are split at Discord's 2000-char limit.
- Gateway heartbeat/resume with backoff reconnect; fatal close codes exit for
  systemd to restart.
- HTTP 429 throttling on outbound REST is retried with `retry_after`.
- Every DB touch degrades: no Postgres, no provider key, or a failing
  provider means the agent answers on the fallback model instead of failing
  the turn.

## Evals

```bash
./scripts/eval-ci.sh                 # strict, all evals
./scripts/eval-ci.sh --list          # list without running
```

`provider-switch-active` and `provider-config-persists` assert the model id
the agent reports (expectation from `EVAL_ACTIVE_MODEL_ID`). Full eval runs
need Doppler keys. Memory evals (`memory-remember-recall`,
`memory-no-fabrication`, `memory-citation`, `memory-pdf-capture`) and unit
tests for `nets`/`discord-util` are still deferred.

## Upgrades

Pin the framework line and read release notes before bumping:

- `packages/agent/package.json` → `eve` (stay on `^0.31.x` until release
  notes say otherwise; matching `@workflow/*` versions are published
  alongside).
- `packages/agent/package.json` → `ai` + `@ai-sdk/openai` (keep the
  `@ai-sdk/openai` version aligned with the one eve bundles).
- `@workflow/world-postgres` must be built against the same `@workflow/*` line
  as the installed eve.

## Privacy

By design: no public inbound endpoint, single-owner only, memory writes go to
innernet, and model calls go to your chosen BYOK provider. innernet, the
provider endpoints, and Discord are third parties — do not put secrets or data
you cannot share into the agent.
