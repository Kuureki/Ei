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
- **Provider registry + ops** — `providers`, `models_cache`, and
  `config` tables in the same Postgres as the workflow world. Slash
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
- Postgres reachable via `WORKFLOW_POSTGRES_URL` (required — the agent fails
  fast at boot without it). The same database hosts the workflow world
  (`workflow` schema) and the agent's tables (`providers`, `models_cache`,
  `config`, `schedules`, `schedule_runs`, `issues`).

## 3. Setup

```bash
git clone <url> Ei && cd Ei
bun install
ei setup      # authenticates and creates project "ei" + config "prd" (see below)
```

`ei setup` never writes a Doppler scope file: every command uses
`--project ei --config prd` explicitly so other projects on the same host keep
their own defaults. Set the environment values from `docs/ENV.md` (secrets +
non-secrets) with `doppler secrets set --project ei --config prd <NAME>=<value>`
or `doppler import`. Tables migrate automatically at boot — nothing to run.

## 4. Run

Dev (hot reload, no gateway unless envs are set):

```bash
doppler run --project ei --config prd -- bun run --cwd packages/agent dev
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
ExecStart=/usr/local/bin/doppler run --project ei --config prd -- bunx eve start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Health: `curl http://127.0.0.1:3000/eve/v1/health`. `POST /intake` and
`POST /interact` return `403` without the connector secret.

## 5. Register commands

```bash
doppler run --project ei --config prd -- bun scripts/register-commands.ts          # PUT the provider command
doppler run --project ei --config prd -- bun scripts/register-commands.ts --dry-run # preview payload
doppler run --project ei --config prd -- bun scripts/register-commands.ts --list    # current registration
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
   Or do both from the CLI — it reuses the exact same flow as the modal:
   `ei provider add <name> <base_url> [--key-env NAME] [--api-key KEY] [--headers JSON]`
   (no `--api-key` prompts masked; an empty answer registers without a key).
3. `/provider test <name>` — one-token completion against the provider.
4. `/provider refresh <name>` — re-discover models from `/v1/models` +
   models.dev.
5. `/provider use <model>` — autocomplete from the live catalog; the active
   model applies from your **next message** (no restart).

`/provider list` shows each provider's key status (set/unset), cached model
counts by source, and marks the active one.

## 7. Operations

- Logs: `journalctl -u ei -f`.
- Upgrade: `git pull && bun install && doppler run --project ei --config prd -- bunx eve build` then
  restart the unit. `ei upgrade` automates this; `ei status` shows the
  result of both.
- The gateway logs fatal close codes and exits for systemd to restart; the
  agent answers on the fallback model when the active provider is
  unavailable.

## 8. CLI

`ei` is a compiled, self-updating command line for operating the agent.
Install on any Linux box with one command:

```sh
curl -fsSL https://raw.githubusercontent.com/Kuureki/Ei/main/install.sh | sh
```

Prefer downloading and inspecting first? Same script, two steps:

```sh
curl -fSL https://raw.githubusercontent.com/Kuureki/Ei/main/install.sh -o install.sh
sh install.sh
```

`EI_VERSION=<tag>` pins a specific release (default: latest),
`EI_INSTALL_DIR=<dir>` overrides the install prefix (default
`/usr/local/bin` via `sudo`, else `~/.local/bin`). The binary is verified
against a `.sha256` sidecar before install.

    ei setup     bootstrap a host (doppler, deps, build, register, systemd)
    ei upgrade   self-update the binary, then advance the checkout to the
                 latest tag (install, build, re-register, restart, health)
    ei status    health card — agent, systemd, model, providers, schedules
    ei logs      tail/follow the systemd unit
    ei provider  add | list | test | refresh | use the active model off-Discord
    ei evals     run the eval suite under doppler
    ei doctor    preflight report (never mutates)

Runtime from source: `bun run cli -- <cmd>`. Releases build
`ei-linux-x64` / `ei-linux-arm64` binaries in GitHub Actions on `v*` tags;
`ei upgrade` self-replaces the binary and pulls the agent from git.

All commands support `--dry-run` (plan only) and `--json` (machine output),
and are covered by `bun test` (`packages/agent/cli/**/*.test.ts`).

## 9. Testing

```bash
cd packages/agent
bun test                 # unit tests (pg-mem backed, no network)
bun run typecheck        # strict tsc
../scripts/eval-ci.sh    # eve evals (needs Doppler keys; sets EVE_GATEWAY_DISABLED)
```

## 10. Security

- Keys are referenced **by name** only — `providers.key_env` stores the
  Doppler var name, never the value; plaintext never lands in Postgres,
  Discord, or the repo.
- Command replies are ephemeral; outbound replies never ping
  (`allowed_mentions: { parse: [] }`).
- Owner gates at both layers: the loopback secret header **and** the Discord
  user id.
- No public inbound endpoint (gateway connects out).

## 11. Scaling / future

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
- Every DB touch is non-fatal after boot: no provider key, a failing
  provider, or a Postgres hiccup means the agent answers on the fallback
  model instead of failing the turn (boot itself still requires Postgres).

## Scheduled jobs

The agent can create, run, and report on scheduled jobs from plain Discord
(say "remind me tomorrow at 9am…" or "digest my calendar every weekday").
Jobs are stored in `schedules` + `schedule_runs` (same Postgres), run
on a minute-tick dispatcher (`agent/schedules/dispatcher.ts`), and deliver
their reply to the owning DM. Ask "what did <job> do?" and the agent reports
from `schedule_runs`. Jobs that fail 3 consecutive runs pause themselves.

## Self-healing & evolution

Two authored schedules watch the jobs you've scheduled in Discord:

- `health` (daily 09:00 UTC) assesses every enabled job and opens/resolves an
  issue row in `issues` when a job degrades (3 consecutive failures, a
  success rate under 60%, or 14+ days without an update). Detection only: a
  directive is posted to the job's thread, and any repair is applied by you
  after the agent drafts options — never automatically. Jobs that fail 3
  consecutive deliveries still pause themselves (the dispatcher brake).
- `lineage` (weekly Mon 11:00 UTC) picks the worst-health eligible job and
  asks the agent to draft four prompt variations (A–D). Only the job's prompt
  ever changes, and only after you pick a variation in-thread; the pick is
  recorded in the job's tags.

Ask "what's broken?" in Discord and the agent reports from the issue state.

## Improve loop (sentrux)

Ask the agent to improve any git repo on the VPS ("improve /path/to/repo").
It installs the [sentrux](https://github.com/sentrux/sentrux) sensor on
first use, scans the repo through sentrux's MCP server (in-process, stdio),
then runs a bounded loop: plan a small refactor targeting the worst root
cause (modularity, acyclicity, depth, equality, redundancy), edit with the
host-backed file/shell tools, rescan, keep-or-revert, and commit each kept
change. It stops at the target score, two flat rounds, or
`EI_IMPROVE_MAX_ROUNDS` (default 8), then commits (and pushes, never force)
and reports the before/after signal in Discord. The agent is unsandboxed by
design: it has root access to the whole VPS from `EI_AGENT_ROOT` (`/`).

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
