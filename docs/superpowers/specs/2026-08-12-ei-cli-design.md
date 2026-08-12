# Ei CLI — Setup, Upgrade, Status, Provider Ops, Evals

**Status:** approved design, pre-implementation
**Date:** 2026-08-12
**Drivers:** operational comfort for the self-hosted agent, beautiful command output, self-updating binary

## 1. Goal

A terminal CLI for Ei that is the operational twin of the Discord surface: `ei setup` boots a fresh host, `ei upgrade` takes a running deployment from tag A to tag B, `ei status` surfaces health at a glance, `ei provider` manages the active model off-Discord, and `ei evals` runs the eval suite. Output is deliberately beautiful (colored steps, cards, tables) in the `bunx`/`cargo`/`orbctl` style: commands run and exit; there is no live dashboard.

**Design posture that shapes everything:** the eve agent is not single-binary shippable — production runs `eve start` from a source checkout (systemd unit with `WorkingDirectory`), and eve's compiled `.output` does not run standalone on Bun's store layout. Therefore:

- The **CLI itself** is the compiled binary (built in GitHub Actions, released per tag, self-updating).
- The **agent** stays a git checkout on the host; `ei upgrade` advances it via git tag + `bun install` + typecheck + build + re-register + restart.

## 2. Non-goals (YAGNI)

- No live dashboard / `ei tui` (user explicitly chose command-per-run output).
- No remote/multi-host management, no fleet control.
- No analytics, no telemetry, no phone-home beyond the GitHub releases API used by `ei upgrade`.
- No bundling the agent into a release artifact (see design posture; revisitable later, not now).

## 3. Architecture & layout

New directory `packages/agent/cli/` inside the agent package. Rationale: the CLI imports the agent's existing pure-TS layers directly (`../lib/db`, `../lib/providers`, `../lib/models-dev`, `../lib/discovery`, `../lib/schedule-store`, `../lib/health`, `../lib/issues`) — none of them import `eve`; they are plain TypeScript over `pg` and `fetch`. eve's compiler only scans `agent.ts`, `tools/`, `channels/`, `schedules/`, `evals/`, `instructions/`, `subagents/`, so `cli/` is invisible to the agent build.

```
packages/agent/cli/
  main.ts            # arg dispatch + top-level error handling + exit codes
  args.ts            # tiny hand-rolled parser (flags, positionals, --json/--dry-run)
  config.ts          # read/write user config, discover checkout + unit
  env.ts             # doppler secrets bridge (names only, values never printed)
  version.ts         # semver compare, embedded version constant, release asset URLs
  upgrade.ts         # upgrade state machine (CLI self-update + agent update)
  run.ts             # shell-out helpers: git/bun/doppler/systemctl/sudo, captured stderr
  commands/
    setup.ts upgrade.ts status.ts logs.ts doctor.ts evals.ts
    provider-list.ts provider-test.ts provider-refresh.ts provider-use.ts
  ui/
    banner.ts step.ts card.ts table.ts prompts.ts theme.ts
  *.test.ts          # bun test picks these up via the package's default glob
```

- Entry for compilation: `cli/main.ts`, `bun build --compile --target bun-linux-x64` and `bun-linux-arm64` (macOS targets deferred until needed).
- `packages/agent/tsconfig.json`: add `"cli/**/*.ts"` to `include` so `tsc` covers it (current include list does not).
- `bun test` already scans the whole package, so `cli/**/*.test.ts` runs in CI unchanged.

## 4. Command reference

Every command supports `--dry-run` (render the exact plan with resolved inputs, mutate nothing, exit 0) and `--json` (machine-readable output). Both flags are honored by the GH Actions smoke test.

```
ei setup      # preflight (bun, git, doppler, pg reachable) -> doppler setup ->
              # bun install -> typecheck + build:agent -> register-commands ->
              # install systemd unit (sudo, one prompt) -> enable+start -> poll health
ei upgrade    # release check -> CLI self-update (if newer) -> git checkout <tag> ->
              # bun install --frozen-lockfile -> typecheck -> build ->
              # re-register commands -> restart unit -> poll health
ei status     # health card: agent health, systemd state, active model, providers,
              # schedules/issues summary (Postgres via lib), short log tail
ei logs       # journalctl -u ei -n 100 (default); --follow adds the live -f mode
ei provider   # list | test <name> | refresh <name> | use <model>   (DB + live APIs)
ei evals      # run scripts/eval-ci.sh with step rendering
ei doctor     # full preflight report, never mutates, always exits 0 with report
ei version    # embedded version constant ("dev" when run from source)
ei help       # command tree + flags
```

- `ei setup` on a host without systemd (laptop, container): prints manual run instructions and skips the unit steps; `status`/`logs` degrade to health-endpoint + no-unit notes.
- `ei provider list`: from `listProviders`, `getActiveModel`, plus key-set status per provider (membership of the provider's key env name in doppler secrets — values never printed or transmitted).
- `ei provider test <name>`: reuses the same one-token probe logic as the Discord `/provider test` path — `testProvider` from `lib/commands` (gets an `export` so the CLI can call it; behavior unchanged, existing tests untouched).
- `ei provider refresh <name>`: reuses `lib/discovery` + `lib/models-dev` refresh catalog logic.
- `ei provider use <model>`: `setActiveModel` from `lib/providers`, same row the Discord `/provider use` writes.

## 5. Config & secrets

**User config** — written by `ei setup`, read by every command, overridable with `--checkout`/`--unit` flags:

```json
// $XDG_CONFIG_HOME/ei/config.json (default ~/.config/ei/config.json)
{
  "checkoutPath": "/opt/ei",
  "unitName": "ei",
  "dopplerProject": "ei"
}
```

**Secrets bridge (`env.ts`)**: `doppler secrets download --no-file --format json` once per command, cached in-process; used only for (a) membership checks of provider key names, (b) `WORKFLOW_POSTGRES_URL` so `lib/db` can connect directly for status/provider reads. Secret values are never rendered, logged, or written to config. Mutating commands that need agent env (`register-commands` needs `DISCORD_BOT_TOKEN`/`DISCORD_APP_ID`) are wrapped via `doppler run --project <p> -- …`.

## 6. UI kit

`cli/ui/` on `@clack/prompts` + `picocolors`, nothing heavier:

- `banner()` — one- or two-line versioned Ei wordmark, small (no figlet).
- `step()/stepOk()/stepFail()` — checkbox progress (clack spinner + `log.success`/`log.error`), used by `setup`/`upgrade`/`evals`.
- `card(title, rows)` — box-drawn key/value card with aligned columns, used by `status` and `doctor`.
- `table(headers, rows)` — two+ column table with truncation, used by provider list and schedules/issues.
- `prompts` — clack `confirm`, `select`, `text` for interactive choices.
- `theme.ts` — the palette: green = ok, yellow = warning, red = fail, dim = secondary; bold headings; no rainbow.

Reference render for `ei status` (mockup, not contractual):

```
  ╭─ Ei · 0.4.2 ────────────────────────────────────╮
  │ Agent health    ● ok        version 0.4.2       │
  │ Systemd ei      active      uptime 12d 4h        │
  │ Active model    groq/llama-3.3-70b-versatile     │
  │ Providers       3 configured, 2 keys set         │
  │ Schedules       5 enabled · 1 degraded           │
  │ Open issues     1 (2 consecutive failures)       │
  ╰─────────────────────────────────────────────────╯
```

`--json` output for `status`/`doctor` is a plain JSON object of the same fields (stable keys, documented in the plan).

## 7. Versioning & releases

- **Two workflows:**
  - `.github/workflows/ci.yml` — every push to main/PRs: `bun install`, typecheck (shared + agent incl. cli), `bun test`. This repo has no `.github/` today; the workflow directory is new.
  - `.github/workflows/release.yml` — on `v*` tags: jobs for `bun-linux-x64` and `bun-linux-arm64`, each `bun build --compile` of `cli/main.ts`, artifacts named `ei-linux-x64` / `ei-linux-arm64`, attached to the tag's GitHub Release; then a smoke job runs `--version` and `doctor --json --dry-run` on both artifacts.
- **Embedded version:** release workflow passes `--define "EI_VERSION='<tag>'"`; `version.ts` falls back to `"dev"` when undefined (source runs).
- **Release asset URL:** `https://github.com/Kuureki/Ei/releases/download/<tag>/ei-<platform>` where platform is `linux-x64`/`linux-arm64`.
- **Semver:** tiny pure comparator in `version.ts` (major.minor.patch, prerelease ignored), no dependency; unit-tested.

## 8. Upgrade flow (data flow & state machine)

`ei upgrade` runs in two phases, each step rendered with `step()` and fail-fast:

**Phase 1 — CLI self-update:**
1. `GET https://api.github.com/repos/Kuureki/Ei/releases/latest` (fetch, `accept: application/vnd.github+json`).
2. Compare `latest.tag_name` semver against the embedded `EI_VERSION`. If not newer, skip to Phase 2.
3. Download the asset for the host platform (non-2xx response is an error), verify the file is non-empty and got its executable bit, write to `<dir>/ei.<ver>.new` next to the current binary.
4. Copy the current binary to `ei.bak`, atomic-rename the new file over it, `chmod +x`, run `<binary> version` to confirm it executes.
5. Re-exec: spawn the new binary with the same argv and hand off to Phase 2.

**Phase 2 — agent update (from `config.checkoutPath`):**
1. `git fetch origin`, compare `git describe --tags` of HEAD vs `latest.tag_name`; if equal, exit (nothing to do).
2. `git checkout <tag>`; `bun install --frozen-lockfile`; typecheck; `doppler run --project <p> -- bunx eve build` (build requires the Postgres env per the 2026-08-12 posture change).
3. Re-register commands (`scripts/register-commands.ts` via doppler run).
4. `systemctl restart ei` (via sudo when non-root).
5. Poll `GET http://127.0.0.1:<port>/eve/v1/health` until the new version answers or N attempts pass; on failure print the last `journalctl -u ei -n 50` lines.

**Failure handling:** stop at the first failing step; undo reversible actions (restore `ei.bak`, `git checkout` back to the prior tag); render an error card with the exact failing command, exit code, and stderr tail, plus a "run `ei doctor`" suggestion. Exit code 3 when the failure implies the user must intervene (e.g. dirty checkout, missing sudo).

`--dry-run` performs read-only lookups only: the release API call, plus reading the current checkout tag via `git describe --tags` (no `git fetch`, no checkout). It prints the full plan with resolved versions and paths, mutates nothing, and never restarts anything.

## 9. Error handling & exit codes

- One `main()` wrapper: every command and callback runs inside try/catch; unexpected errors render the error card, not a stack trace (`--debug` toggles the trace).
- Preflight per command runs before any mutation: binaries exist (`git`, `bun`, `doppler`, `systemctl`), config resolves, checkout is a git repo, Postgres reachable (short-timeout `SELECT 1` via `lib/db`) where the command reads the DB. A failed preflight on a mutating command exits `3` (user action required). `doctor` is exempt from the exit contract: it always runs its report and exits `0`, with each check result a field in the output.
- Exit codes: `0` ok; `1` runtime/command failure; `2` usage error; `3` upgrade/preflight requires user action.

## 10. Testing

`bun test` unit coverage, all under `cli/**/*.test.ts` (picked up by the existing package glob), each pure and headless:

- `args.ts` — parser cases, `--json`/`--dry-run` flag handling.
- `version.ts` — semver compare table, embedded-version fallback, asset URL construction.
- `upgrade.ts` — decision logic with a fake release client (newer/equal/older CLI, newer/equal agent tag); failure/rollback paths; `--dry-run` plan rendering snapshot.
- `ui/` — `card`/`table`/`banner` snapshot strings (bun's `toMatchSnapshot`).
- `commands/status` — health JSON parsing, schedule/issues summary against pg-mem via `lib/health` + `lib/issues` (same fixtures pattern as existing tests).
- `provider` commands — `list`/`use` against pg-mem via `lib/providers`.

GH Actions `ci.yml` runs typecheck + this suite on every push; `release.yml` smoke-runs the compiled binaries (`version`, `doctor --json --dry-run`).

## 11. Interfaces (who calls what)

- `main.ts` → dispatches to `commands/*`; each command module has one exported `run(ctx): Promise<number>`.
- `commands/*` → `run.ts` (shell), `env.ts` (secrets), `config.ts`, `ui/*`, and the agent `lib/*` imports listed in §3.
- `upgrade.ts` → `version.ts`, `run.ts`, `config.ts`; depends on nothing else in the CLI.
- Agent `lib/*` files are unchanged **except one export**: `testProvider` in `lib/commands.ts` becomes `export async function` (no behavior change) so the CLI reuses the one-token probe. The remaining libs the CLI imports — `lib/db`, `lib/providers`, `lib/models-dev`, `lib/discovery`, `lib/schedule-store`, `lib/health`, `lib/issues`, `lib/commands` — import only `pg`, `fetch`, `node` built-ins, `@ei/shared`, `ai`, and each other; none import `eve` (verified against source).

## 12. Open questions

None — every decision above was resolved during design (scope, UI mode, UI stack, deployment model, release cadence, secrets handling).
