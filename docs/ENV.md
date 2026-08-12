# Environment reference (Doppler)

Everything runs under `doppler run --`. All values are set with
`doppler secrets set <NAME>=<value>` (or `doppler import` from a JSON map).
Never commit values; the repo contains names only.

## Secrets

| Name | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot token (gateway + REST replies) |
| `DISCORD_APP_ID` | Application id (interaction URLs, registration) |
| `AGENT_OWNER_DISCORD_ID` | Single-owner gate for messages and commands |
| `AGENT_OWNER_GUILD_ID` | Guild for guild-scoped command registration |
| `EVE_CONNECTOR_SECRET` | Shared header for the loopback intake + interact routes |
| `INNERNET_KEY` | innernet.live memory MCP key |
| `WORKFLOW_POSTGRES_URL` | Postgres connection string (required; workflow world + agent tables) |
| `PROVIDER_<NAME>_API_KEY` | One per BYOK provider; the name is stored in `providers.key_env` |
| Whisper key (if used) | For the transcribe tool |

## Non-secret (also set in Doppler)

| Name | Values / notes |
| --- | --- |
| `PORT` | `3000` (default) |
| `WORKFLOW_POSTGRES_JOB_PREFIX` | `ei` |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | optional queue worker count |
| `EVE_RUNTIME_URL` | optional; defaults to loopback `http://127.0.0.1:${PORT}` |
| `EVE_GATEWAY_DISABLED` | `1` in eval/tests so no Discord connection is opened |
| `EVAL_ACTIVE_MODEL_ID` | eval expectation for the active model id |

## Integration layer (slice 2)

| Variable | Required | Purpose |
| --- | --- | --- |
| `COMPOSIO_API_KEY` | no | Composio SDK key. Missing → composio tools surface as disabled/errored; agent boots and runs unchanged. |
| `POSTHOG_PROJECT_TOKEN` | no | PostHog project token (AI observability). Missing → no OTel exporter; agent runs unchanged. |
| `POSTHOG_HOST` | no | PostHog host; default `https://us.i.posthog.com`. |

## Doppler CLI cheat sheet

- `doppler setup --project ei`
- `doppler run -- bun run --cwd packages/agent dev`
- `doppler run -- bunx eve start`
- `doppler secrets set PROVIDER_GROQ_API_KEY=sk-...`
- `doppler secrets get WORKFLOW_POSTGRES_URL`

## CLI

`ei` (see README) reads `$XDG_CONFIG_HOME/ei/config.json`
(`checkoutPath`, `unitName`, `dopplerProject`), written by `ei setup`.
It shells to `doppler`, `git`, `bun`, `systemctl`, and (for the unit steps)
`sudo`. Secret values are never printed; `ei status`/`ei provider` read
`WORKFLOW_POSTGRES_URL` from doppler to query the agent tables directly.

- `EI_INSTALL_DIR` — override `install.sh`'s prefix (default `/usr/local/bin` via sudo, else `~/.local/bin`).
- `EI_VERSION` — pin a release tag in `install.sh` (default: latest).

## Sentrux improve loop

| Variable | Default | Purpose |
| --- | --- | --- |
| `SENTRUX_PATH` | `/usr/local/bin/sentrux` | Explicit path to the `sentrux` binary (skips auto-install; the agent installs it on first use otherwise). |
| `EI_AGENT_ROOT` | `/` | Root the host (unsandboxed) sandbox works from. Relative paths in agent file tools resolve here. |
| `EI_IMPROVE_MAX_ROUNDS` | `8` | Hard cap on improve-loop rounds (read by the agent via the environment). |
| `EI_IMPROVE_TARGET` | — | Optional quality-signal target (0–10000) that ends the improve loop early. |
