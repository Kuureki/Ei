# Ei Integration Layer — Composio, anydoc, PostHog (Slice 2) — Design

Status: approved by user on 2026-08-10
Author: brainstorm session (user + Droid)
Repo: /root/dev/projects/Ei

## 1. Vision and scope

The memory agent (slice 1) captures and queries knowledge. This slice adds
three capabilities on top of the existing single service:

- **Composio** (via the TypeScript SDK as native eve tools) — connect Google
  Calendar, Gmail, and Todoist so the agent can act on the user's personal
  ops: events, email, tasks.
- **anydoc** (`@firecrawl/anydoc`) — a `parse_document` tool that converts
  inbound office documents (`.docx`, `.pdf`, `.pptx`, `.xlsx`, …) to Markdown
  the model can actually read.
- **PostHog** (via eve instrumentation + OTel) — AI traces and analytics for
  the agent: every model call, tool call, and channel HTTP request.

A fourth candidate (dedicated Todoist/TickTick connection) was considered and
**dropped**: Composio's Todoist toolkit covers the tasks/reminders surface, so
a second tasks integration would be redundant.

All four units are independent, additive, and leave the gateway, provider
registry, intake/interact channels, and deploy model untouched.

## 2. Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Composio architecture | TypeScript SDK as **native `defineTool` wrappers** (in-process) | Deepest integration; no MCP hop; static schemas; eve is AI-SDK-based |
| Composio toolkits (v1) | Google Calendar + Gmail + Todoist | The personal-ops triad |
| Composio action level | Full read-write with **`approval: always`** on mutating tools | User wants real actions, gated |
| Approval mechanism | eve per-tool `approval` (authored tools contract) | Built-in, durable, no custom HITL |
| anydoc invocation | **On-demand tool** (`parse_document`) | Model decides; no forced parsing of every attachment |
| Observability | **PostHog Cloud** via `defineInstrumentation` + `registerOTel` | Smart-trace analytics, zero extra infra |
| Deployment | In-process, single `ei.service`; no new processes | Matches existing ops |
| Secrets | Env-var names only (Doppler), never values in code/DB/Discord/repo | Strict Doppler policy from slice 1 |

## 3. Architecture

Four new files / one evals addition; everything else unchanged:

```
packages/agent/
├── agent/
│   ├── connections/composio.ts    # lazy Composio client factory (+ owner id)
│   ├── tools/composio.ts          # re-exports the wrapper tools for eve discovery
│   ├── tools/parse_document.ts    # anydoc tool
│   └── instrumentation.ts         # defineInstrumentation + registerOTel
├── lib/
│   ├── composio.ts                # client + per-call execution helper
│   └── composio-tools.ts          # static defineTool wrappers (the ~12 tools)
└── docs/ENV.md                    # + 3 vars
```

### 3.1 Composio (Units A)

- `lib/composio.ts` lazily creates the SDK client from `COMPOSIO_API_KEY`
  (missing → tools callable but return a clear disabled error; agent boots).
  Owner `user_id` = `AGENT_OWNER_DISCORD_ID`.
- `lib/composio-tools.ts` defines static `defineTool`s:
  - **Google Calendar**: `composio_google_calendar_events_list`,
    `_events_create`, `_events_update`, `_events_delete`
  - **Gmail**: `composio_gmail_threads_search`, `_messages_read`,
    `_messages_send`, `_messages_trash`, `_messages_move`
  - **Todoist**: `composio_todoist_tasks_list`, `_tasks_create`,
    `_tasks_update`, `_tasks_complete`, `_tasks_delete`
- Reads (`list`/`search`/`read`) use `approval: never`. Mutations use
  `approval: always` (eve prompts the user before executing).
- Execution: `composio.tools.execute(slug, { userId, arguments })` → `{ data,
  error? }` → short LLM-readable text; error rendering never includes secrets.
- Toolkit versions are **pinned** at the SDK level (our code parses the
  outputs), so no `dangerouslySkipVersionCheck`; the plan resolves the exact
  version strings during implementation.

### 3.2 anydoc — `parse_document` (Unit B)

- Tool inputs: `{ name, mediaType, documentBase64 }` (bytes already staged by
  the gateway at ≤ 10 MB).
- Calls `@firecrawl/anydoc` `toMarkdownBytes(bytes)` (format sniffed from
  content; CSV needs `name` extension fallback).
- Maps `ConvertErrorCode` → user-visible text: `unsupported` (incl.
  image-only PDF → "scanned PDFs need OCR, not available"),
  `malformed`, `encrypted`, `resourceLimit`, `missingPart`, `io`.
- The npm package is the native-binary delivery (Rust core + Node binding,
  CLI incl.); the implementation spike smoke-checks that it imports/loads
  under Node 24 + Bun. If it fails on the target box, fall back to pure-JS
  (e.g. `mammoth` + `pdf-parse`) behind the same tool interface.

### 3.3 PostHog — `agent/instrumentation.ts` (Unit C)

- `defineInstrumentation`:
  - `functionId`: agent name (default)
  - `recordInputs`/`recordOutputs`: true (default)
  - `traceChannelRequests: true` → HTTP span wrapping `/intake` + `/interact`
  - `setup({ agentName })` → wire the OTel exporter for PostHog (`serviceName`
    = `agentName`)
- **Exporter wiring (implementation step):** `@vercel/otel` is **not** present
  in this eve install (0.31.3 deps only `nitro` + `undici`; `registerOTel`
  appears only as a doc comment in eve types). The plan therefore: (1) vendor
  `@vercel/otel` as an agent dep (`bun add @vercel/otel`) and import it from
  there, or (2) if that fails to expose a compatible OTel API, use the
  `@opentelemetry/exporter-trace-otlp-http` SDK directly with a
  `register()` for the PostHog OTLP endpoint. Either way, the exporter call
  must be safe when `POSTHOG_API_KEY`/`POSTHOG_HOST` are absent (no-op).
- Env: `POSTHOG_API_KEY`, `POSTHOG_HOST` (default `https://us.i.posthog.com`).
  Missing → no exporter; agent runs unchanged (exporter failure is never
  fatal).

## 4. Data flow

- Discord → gateway → `/intake` or `/interact` → turn (unchanged).
- Model decides to call a `composio__*` tool → wrapper executes against
  Composio → result rendered to text → model answers. Mutating calls pause on
  `approval: always`.
- Model decides to call `parse_document` on an attachment → bytes → Markdown
  → model saves/summarizes via innernet as before.
- Every model call / tool call / channel request emits OTel spans → PostHog
  (with channel/guild/thread runtime context).

## 5. Configuration

| Variable | Purpose |
| --- | --- |
| `COMPOSIO_API_KEY` | Composio SDK key |
| `POSTHOG_API_KEY` | PostHog project key |
| `POSTHOG_HOST` | optional; default `https://us.i.posthog.com` |

Owner id reused from `AGENT_OWNER_DISCORD_ID`. All three set in Doppler;
`docs/ENV.md` updated.

## 6. Error handling

- Composio: typed SDK errors + rendered text; missing key → clear "disabled"
  error; no secrets surfaced.
- anydoc: typed `ConvertErrorCode` → friendly message.
- PostHog: exporter failure non-fatal; agent keeps running.
- All three degrade individually; the agent boots and answers with none of
  the new keys.

## 7. Testing

- **Unit (bun test):** argument mapping, approval flags (reads `never`,
  mutates `always`), error→text, missing-key disable, `parse_document`
  schema/errors/oversize, instrumentation presence + `setup` calls
  `registerOTel`.
- **Boot smoke:** boots with no new keys; tools listed with dummy keys;
  `POSTHOG_*` set initializes without crash.
- **Evals:** `tools-registered` (model can see/name the tool categories).
- **Live E2E (user credentials):** Google/Todoist connected via Composio,
  real PostHog; "create a task", "what's on my calendar", "send this draft"
  (approval), a doc attachment parsed; trace visible in PostHog.

## 8. Deployment

- `bun add @composio/core @firecrawl/anydoc @vercel/otel` in
  `packages/agent`.
- No new units/processes; same `ei.service` (`doppler run -- bunx eve start`).
- PostHog exporter: add `@vercel/otel` (or the OTLP HTTP exporter) as an
  agent dep; exact import resolved at implementation (see §3.3).

## 9. Scope guardrails (locked)

- Only the whitelisted wrapper tools are exposed; no arbitrary
  `execute_any`-style tool.
- `approval: always` on every mutating tool; reads never prompt.
- `recordInputs`/`recordOutputs` default true; flip `recordInputs: false` if
  the user wants message payloads out of PostHog.
- No meeting transcription, no email autosend rules, no scheduled jobs
  driving Composio, no multi-user in this slice.

## 10. Non-goals / deferred

- Dedicated Todoist/TickTick connection (dropped).
- Self-hosted Composio MCP server or hosted-MCP-connection mode (C/B of the
  options).
- Self-hosted PostHog (Cloud chosen).
- Full Composio toolkit catalog (only the ~12 wrappers now; more toolkits =
  more wrapper files later).

## 11. Success criteria

From Discord, with approvals on writes:
1. "Create a task …" and "check my calendar" work.
2. "Send this draft …" works, gated by approval.
3. A `.docx`/`.pdf`/`.pptx` attachment is parsed and answerable.
4. Every model call shows up as a trace in PostHog.
5. The agent boots and answers with none of the new keys configured.
