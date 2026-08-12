# sentrux <-> Ei MCP integration — design

Date: 2026-08-12
Status: approved (design review)
Related: [ei install design](./2026-08-12-ei-install-design.md), ei CLI design/plan.

## Goal

Ei's agent (the eve-hosted Discord agent) becomes an unsandboxed, full-VPS
coding agent in the shape of hermes: it runs from the agent root with root
access to the whole filesystem, and it can continuously improve a codebase
using sentrux's structural quality signal as its sensor, on request:

"improve <path>" → sentrux scan → edit → rescan → until better/flat/capped →
commit (and push) → report before/after.

The sentrux integration is **real MCP**: the agent talks to sentrux's own MCP
server (`sentrux --mcp`, stdio) over the Model Context Protocol via the
official `@modelcontextprotocol/sdk` client, in-process — no HTTP bridge, no
port, no extra long-running process.

## Decisions (from design review)

- **Coding agent:** Ei's own agent, asked in Discord.
- **Scope/autonomy:** full VPS from the start. Agent starts at `/`, root user,
  can read/write/run anywhere. Granted autonomies: run shell + edit files
  freely; `git add`/`commit` on its own; `git push` without asking;
  install packages (apt/npm/bun) and restart services (systemd) as part of
  fixes. The only hard loop safeguard is the round cap (Section 4).
- **sentrux seam:** Option A — in-process MCP client via
  `@modelcontextprotocol/sdk@^1.30` (`Client` + `StdioClientTransport`),
  surfaced to the model as nine eve tools.

## Components

### 1. Host sandbox backend — `packages/agent/agent/sandbox/sandbox.ts`

A custom `SandboxBackend` named `"host"` (from `eve/sandbox`), mounted via
the folder layout (`agent/sandbox/sandbox.ts`), replacing the default
sandbox. It removes eve's isolation: the built-in `bash`, `read_file`,
`write_file`, `glob`, `grep` tools then operate on the real VPS filesystem
with cwd `EI_AGENT_ROOT` (default `/`).

Implementation is minimal because eve already provides the surface
machinery:

- `prewarm()` → `Promise.resolve({ reused: false })`. No template state.
- `create()` → returns `SandboxBackendHandle` whose `session` is built with
  eve's exported `buildSandboxSession(primitives, setNetworkPolicy?)`
  (`eve/dist/... execution/sandbox/session`), where `primitives`
  (`InternalSandboxSession`) is:
  - `id` — stable per-session string (e.g. `host-<sessionKey>`).
  - `spawn` — `node:child_process` `spawn` with `shell`, resolved cwd, and a
    module-level registry of live children so `SandboxBackendHandle.shutdown`
    kills them on server stop; supports `wait()`/`kill()` and stdout/stderr
    streams per the AI SDK `Experimental_SandboxProcess` shape.
  - `readFile` / `writeFile` — byte-stream I/O via `node:fs` (`fs.createReadStream`
    / `createWriteStream`) on host paths; relative paths resolved from
    `EI_AGENT_ROOT`.
  - `removePath` — `fs.rm` (honoring `force`/`recursive`).
  - `resolvePath` — absolute-ize against `EI_AGENT_ROOT`.
  - `setNetworkPolicy` — no-op (documented; the host has no firewall seam).
- `shutdown()` — kills tracked children; completes promptly.

The public `SandboxSession` methods (`run`, text/binary read-write, line
ranges, encodings) come free from `buildSandboxSession`.

Explicitly out of scope: sandbox isolation. This is the intended
hermes-style trust model — see Security below.

### 2. sentrux MCP tools — `packages/agent/agent/tools/sentrux.ts`

One module exporting nine eve tools (`defineTool` from `eve/tools`, schema
via `zod`), mapping 1:1 to sentrux's MCP registry:

| eve tool | sentrux MCP tool | input |
| --- | --- | --- |
| `sentrux_scan` | `scan` | `{ path: string }` (required) |
| `sentrux_rescan` | `rescan` | `{}` |
| `sentrux_session_start` | `session_start` | `{}` |
| `sentrux_session_end` | `session_end` | `{}` |
| `sentrux_health` | `health` | `{}` |
| `sentrux_check_rules` | `check_rules` | `{}` |
| `sentrux_git_stats` | `git_stats` | `{ days?: integer }` |
| `sentrux_dsm` | `dsm` | `{ format?: "text" \| "stats" }` |
| `sentrux_test_gaps` | `test_gaps` | `{ limit?: integer }` |

Input schemas are hand-mirrored from sentrux's `handlers.rs` /
`handlers_evo.rs` `input_schema` JSON (exact shapes copied at
implementation time from the sentrux repo at a pinned ref; note the repo
README's "evolution" tool is named `git_stats` in the MCP registry).

Shared module machinery:

- **Binary guarantee** — on first tool use, if `SENTRUX_PATH` is unset or the
  binary is missing:
  1. detect arch (`process.arch`): `x64` → `sentrux-linux-x86_64`,
     `arm64` → `sentrux-linux-aarch64` (others: error "unsupported
     architecture");
  2. download `https://github.com/sentrux/sentrux/releases/latest/download/<asset>`
     to `/usr/local/bin/sentrux` (temp file + atomic rename, `chmod 755`);
  3. smoke: `sentrux --version` non-empty.
  Failure at any step returns a descriptive tool error (manual install
  instructions: the curl one-liner from sentrux's README).
- **Protocol client** — lazy process-wide singleton: `@modelcontextprotocol/sdk`
  `Client` with `StdioClientTransport` spawning `sentrux --mcp`. Connection
  errors during init surface as tool errors.
- **Call path** — each wrapper does `client.callTool({ name, arguments })`
  and returns the parsed JSON from `content[0].text` (structured, not
  scraped CLI output). Empty/failed calls return sentrux's error text with
  `isError` semantics mapped to a thrown error.
- **Resilience** — one auto-reconnect per call: on transport failure, close,
  respawn, and retry once. Note for the loop: a respawn loses sentrux's
  in-memory `scan_root`/baseline, so the loop re-runs `session_start` after
  any reconnect.

### 3. sentrux installer reuse — `ei doctor`, `ei setup`

- `ei doctor` gains a `sentrux` row: binary resolvable + `sentrux --version`
  succeeds. Same card style as the existing bun/git/systemd checks.
- `ei setup` gains an optional "install sentrux" step (idempotent): reuses
  the same asset-resolution + download logic so the CLI, not only the agent
  runtime, can install sentrux. The plan card lists it; `--dry-run` shows it
  without acting.
- `installSentrux` logic lives in one module under `packages/agent/lib/`
  (the shared root already used by `lib/db.ts` and friends), consumed by
  both the agent tool module and the CLI — no duplicated download code.

### 4. The improve loop — `packages/agent/agent/instructions/03-improve.md`

A new instruction file describing the loop the model runs when asked to
improve a codebase. Numbering follows the existing `01-voice.md`,
`02-style.md`.

Protocol:

1. **Target** — confirm the absolute path is a git repo; note the user's
   goal, default "raise the sentrux quality signal".
2. **Baseline** — `sentrux_scan <path>` then `sentrux_session_start`; read
   `sentrux_health` for the bottleneck root cause (modularity, acyclicity,
   depth, equality, redundancy) and the concrete diagnostics when present.
3. **Plan** — target the worst root cause with small, enumerated refactors;
   no shotgun edits.
4. **Loop (bounded)** — per round:
   - make a small slice of edits via the host-backed `bash`/`read_file`/
     `write_file` tools;
   - run cheap project checks when available (tests/typecheck);
   - `sentrux_rescan`, compare the signal;
   - improved → keep, `git add -A` + `git commit` with a message citing the
     metric delta; flat or worse → `git checkout` the slice away (revert);
   - **stop when any of**:
     - target score reached (or `EI_IMPROVE_TARGET`),
     - two consecutive rounds with no improvement,
     - `EI_IMPROVE_MAX_ROUNDS` reached (default 8),
     - two regressions reverted.
5. **Finish** — net positive and a remote exists → `git push` (never
   `--force`); reply in Discord with before → after signal, rounds, commits,
   files touched, remaining bottlenecks; if it made no progress, say so
   plainly and show what was tried.

The round cap is the single hard bound against infinite looping; everything
else stays model-driven and legible. Per-round commits keep history safe and
reversible.

## Data flow

Discord: "improve /root/dev/projects/foo" →
eve session (host backend, cwd `/`, full VPS) →
`sentrux_scan`/`session_start`/`health` (SDK client → `sentrux --mcp` →
sentrux scans the repo on the host, JSON-RPC back) →
model edits files with built-in tools →
`sentrux_rescan`/`session_end` →
commit/push → summary reply.

## Environment (`docs/ENV.md`)

| var | default | meaning |
| --- | --- | --- |
| `SENTRUX_PATH` | unset | explicit sentrux binary path (skips auto-install) |
| `EI_AGENT_ROOT` | `/` | host-backend cwd and relative-path anchor |
| `EI_IMPROVE_MAX_ROUNDS` | `8` | hard loop round cap |
| `EI_IMPROVE_TARGET` | unset | optional target quality signal (0–10000) |

## Error handling

- **sentrux missing**: tools auto-install (one-line "installing sentrux…"
  notice); install failure → descriptive error + manual-install pointer;
  `ei doctor` flags the same condition offline.
- **MCP transport failure**: one respawn+retry per call; if the client
  cannot reconnect, the tool throws the underlying message. Loop guidance
  re-establishes the baseline after a respawn.
- **Loop**: round cap enforced; regressions reverted via git; destructive
  commands and service restarts remain at the model's discretion per the
  granted autonomy, with git as the undo layer for repo state.

## Security

This design intentionally removes eve's sandbox isolation: the built-in
tools execute as root over the whole VPS. That is the requested hermes-style
trust model and is documented in the plan's security section. The grant is
scoped to the single-owner Discord agent (existing owner gate). No
additional network exposure: sentrux's server is local stdio, the MCP client
is in-process, and no new ports open. Keep secrets policy unchanged
(provider keys referenced by name; nothing new lands in Postgres/Discord).

## Testing

All `bun test`, pg-mem/offline style — no real sentrux binary and no network
in CI:

- **Host backend** (`agent/sandbox/host-backend.test.ts`): construct the
  backend pointed at a temp root (`EI_AGENT_ROOT` = tmpdir via injected
  root), assert `run` (pwd/echo), `writeTextFile`→`readTextFile`,
  `removePath` (with/without `recursive`), `resolvePath` anchoring, and
  that `shutdown()` terminates a spawned `sleep` child.
- **sentrux tools** (`agent/tools/sentrux.test.ts`): run the module's client
  against a **fixture stdio MCP server** (a tiny spawned script implementing
  the same minimal JSON-RPC loop as `sentrux --mcp`: initialize,
  tools/list, tools/call returning canned JSON-RPC content). Assert each of
  the nine wrappers issues its `tools/call` with the right `name`, returns
  parsed content objects, passes through sentrux-style error text as thrown
  tool errors, and that a killed fixture triggers the one-respawn-retry.
- **Install helper** (`cli` tests): arch→asset mapping and URL building as
  pure functions with injected fetcher; no real download in tests.
- **Manual smoke during implementation** (not CI): real `sentrux` binary
  against a scratch git repo; `ei doctor` shows the new row; `ei setup
  --dry-run` lists the sentrux step; one live "improve" round on a scratch
  repo.

CI stays as-is; the new `@modelcontextprotocol/sdk` dep lands in
`bun.lock` so `bun install --frozen-lockfile` keeps working. Full suite
(`bun test` in `packages/agent`) and both typechecks (`bun run typecheck`)
must stay green; the CLI's own tests extend only the doctor/setup unit
surface.

## Out of scope (explicitly)

- Writing our own static-analysis logic; sentrux stays the sensor.
- An HTTP/SSE bridge or `defineMcpClientConnection` (not needed; Option A).
- A standalone `ei improve` CLI command — the loop is Discord-driven; `ei`
  only gains the doctor/setup sentrux rows here.
- Sandbox isolation, network policies, multi-user/auth expansion — the
  single-owner full-VPS model replaces them by design.
