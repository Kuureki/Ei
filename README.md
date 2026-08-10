# Ei — personal agent memory core

A self-hosted personal memory agent built on [eve](https://eve.dev). You talk
to it in Discord (server or DM); it captures durable knowledge into
[innernet](https://innernet.live/) and answers queries from memory with
citations. It is the first slice of a larger personal agent: files arrive as
text, code, documents, images, or voice memos, and everything is queryable
later.

## Architecture

```
Discord (your messages + attachments, incl. voice)
   │  outbound WebSocket (gateway)
   ▼
packages/connector   Bun sidecar, zero deps: identify/heartbeat/resume,
   │                 filters to the single owner, downloads attachments,
   │                 POSTs { userId, guildId, channelId, threadId, text, files }
   │                 to the loopback intake
   ▼
packages/agent       eve app (Node 24 runtime)
   │  channels/discord.ts   custom defineChannel route POST /intake
   │                        (secret + owner gate → from(token).send)
   │  connections/innernet.ts  MCP connection (Bearer INNERNET_KEY)
   │  tools/fetch_page.ts       SSRF-guarded URL → markdown
   │  tools/transcribe_audio.ts Whisper for voice memos
   │  instructions.md           capture/query contract, no-invention rule
   │
   ├─► awaiting model step:  anthropic/claude-sonnet-5 (cloud API)
   ├─► memory writes/reads: innernet MCP
   └─► outbound replies:    Discord REST (split at 2000 chars, typing shown)
```

There is **no Docker** and **no public inbound endpoint**: the connector
connects out to `wss://gateway.discord.gg`, and the agent serves on
`127.0.0.1` with the intake guarded by a shared secret.

Design details are in `docs/superpowers/specs/2026-08-10-personal-agent-memory-core-design.md`
and the plan in `docs/superpowers/plans/2026-08-10-personal-agent-memory-core.md`.

## Workspace layout

Bun-managed monorepo. Bun is the package manager and task runner; the eve
server itself executes under Node 24 (eve's engine) — verified in the Task 1
spike: `bun run dev` launches the `eve` CLI whose bin runs on Node. In
production, start everything with `eve start` (its loader resolves framework
packages; running `node .output/server/index.mjs` directly fails on Bun's
`.bun/` store layout).

| Path | Package | What it is |
| --- | --- | --- |
| `packages/agent` | `@ei/agent` | The eve app (channels, connection, tools, instructions) |
| `packages/connector` | `@ei/connector` | Discord gateway sidecar (Bun, zero runtime deps, bundled) |
| `packages/shared` | `@ei/shared` | Pure helpers (`nets`, `discord-util`) built to `dist/` |

Root scripts: `dev:agent`, `build:agent`, `start:agent`, `dev:connector`,
`build:shared`, `typecheck`, `typecheck:agent`, `typecheck:shared`.

## Quick start (local)

```bash
bun install
cp packages/agent/.env.example packages/agent/.env.local   # fill in the keys
bun run dev:agent            # eve dev server on :3000
bun --env-file=packages/agent/.env.local run --cwd packages/connector dev
```

Then talk to the bot in Discord. `curl http://127.0.0.1:3000/eve/v1/health`
should return `{"ok":true,...}`.

## Run on your server (no Docker)

Prereqs: a Unix box with Bun and Node 24, and — for production — a Postgres
server (the agent's durable world). Deploy with systemd, two units:

1. Build the agent and run it with `eve start` (never plain `node` on the
   `.output` bundle):

```bash
cd packages/agent
bun run build
bunx eve start          # serves http://127.0.0.1:3000/
```

2. The connector, with the same env (it knows the token/owner/secret and the
   agent's base URL):

```bash
cd packages/connector
bun run build           # produces dist/index.js
bun --env-file=../agent/.env.production start
```

Sample systemd units (adjust `User=`, paths, and the env file; one env file
for both services is fine, gitignored):

`/etc/systemd/system/ei-agent.service`:

```ini
[Unit]
Description=ei personal agent (eve)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/Ei/packages/agent
EnvironmentFile=/home/youruser/Ei/.env.production
ExecStartPre=/home/youruser/.bun/bin/bun run build
ExecStart=/home/youruser/.bun/bin/bunx eve start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/ei-connector.service`:

```ini
[Unit]
Description=ei discord connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/Ei/packages/connector
EnvironmentFile=/home/youruser/Ei/.env.production
ExecStartPre=/home/youruser/.bun/bin/bun run build
ExecStart=/home/youruser/.bun/bin/bun dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

With `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` and
`WORKFLOW_POSTGRES_URL` set in the env file, the agent's durable state
(sessions, queues, streams) lives in your Postgres (`@workflow/world-postgres`,
the eve production world). Without them the agent uses the zero-DB local world
(`eve dev` works without any database).

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` or `AI_GATEWAY_API_KEY` | one of | Model credential for `anthropic/claude-sonnet-5` |
| `OPENAI_API_KEY` | optional | Whisper transcription of voice memos |
| `INNERNET_KEY` | yes | innernet Bearer key (from https://innernet.live/account) |
| `DISCORD_BOT_TOKEN` | yes | Bot token (gateway + REST replies) |
| `DISCORD_APPLICATION_ID` | yes | Application id (portal) |
| `AGENT_OWNER_DISCORD_ID` | yes | The single owner; everyone else is silently dropped |
| `EVE_CONNECTOR_SECRET` | yes | Shared secret for the loopback `/intake` route |
| `EVE_RUNTIME_URL` | optional | Agent base URL for the connector (`http://127.0.0.1:3000`) |
| `EVE_INTAKE_PATH` | optional | Intake route (default `/intake`) |
| `EVE_GATEWAY_URL` | optional | Discord gateway override (local testing) |
| `WORKFLOW_TARGET_WORLD` | prod | `@workflow/world-postgres` selects the durable Postgres world |
| `WORKFLOW_POSTGRES_URL` | prod | Postgres connection string (with the world above) |
| `PORT` | optional | Default 3000 |
| `HOSTNAME` | optional | Bind host for containers/remote (`0.0.0.0`) |

## Discord prerequisites

- Developer portal → Applications → your app → **Bot**: enable *Message
  Content Intent* (required for the gateway to receive message text).
- Invite URL with scope `bot` and basic text permissions
  (`applications.commands` is **not** required).
- Put your Discord user id in `AGENT_OWNER_DISCORD_ID`.

## Error handling (what's built in)

- Non-owner messages are dropped without a reply, before and at the intake.
- Attachments > 10 MB are rejected with a one-line notice.
- Replies are split at Discord's 2000-char limit; outbound messages never ping
  (`allowed_mentions: { parse: [] }`).
- Gateway heartbeat/resume with backoff reconnect; fatal close codes exit for
  systemd to restart.
- HTTP 429 throttling on outbound REST is retried with `retry_after`.

## Evals

Evals are **deferred** (see below); once the suite exists, run:

```bash
./scripts/eval-ci.sh                 # strict, all evals
./scripts/eval-ci.sh --list          # list without running
```

The script runs `eve eval --strict --junit .eve/junit.xml` from `packages/agent`.

## Deferred: tests

Deliberately deferred per project decision (2026-08-10). Before any production
cutover, complete:

1. Unit tests (vitest, when wired) for `packages/shared/src/nets.ts`
   (`isPublicHttpUrl`), `packages/shared/src/discord-util.ts`
   (`encodeToken`/`decodeToken`/`splitReply`), and the tool input validation.
2. The eval suite from spec §6 in `packages/agent/evals/`:
   - `memory-remember-recall` — capture then recall the same fact.
   - `memory-no-fabrication` — unknown topic answers exactly "Not in memory."
   - `memory-citation` — answers cite retrieved memory.
   - `memory-pdf-capture` — ingest a document attachment and query it.
3. Verify `scripts/check-innernet-manifest.sh` passes with the real tool names
   in `docs/innernet-tools.md` (populate it from `eve info` with `INNERNET_KEY`
   set: `SAVE_TOOL`, `SEARCH_TOOL`).

Live end-to-end verification (Task 2 steps 4-5 and Task 5 step 5 of the plan)
also requires real credentials (`INNERNET_KEY` + a model key): innernet's MCP
endpoint is OAuth 2.1 with Bearer auth and does not expose tool names
unauthenticated.

## Upgrades

Pin the framework line and read release notes before bumping:

- `packages/agent/package.json` → `eve` (stay on `^0.31.x` until release notes
  say otherwise; matching `@workflow/*` versions are published alongside).
- `packages/agent/package.json` → the `ai` override (root `package.json`
  `overrides`).
- `@workflow/world-postgres` must be built against the same `@workflow/*` line
  as the installed eve.

## Privacy

By design: no public inbound endpoint, single-owner only, memory writes go to
innernet, and model calls go to the configured provider. innernet and the model
provider are third parties — do not put secrets or data you cannot share into
the agent.
