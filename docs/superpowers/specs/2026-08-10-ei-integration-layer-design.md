# Ei Integration Layer — Composio, anydoc, PostHog (Slice 2) — Design

Status: approved by user on 2026-08-10
Author: brainstorm session (user + Droid)
Repo: /root/dev/projects/Ei

## 1. Vision and scope

The memory agent (slice 1) captures and queries knowledge. This slice adds
three capabilities on top of the existing single service:

- **Composio** (via the official `@composio/experimental/eve` provider) —
  connect Google Calendar, Gmail, and Todoist so the agent can act on the
  user's personal ops: events, email, tasks.
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

> Implementation note (2026-08-10): both Composio and PostHog publish
> first-party eve integrations, verified against `docs.composio.dev/docs/providers/eve`
> and `posthog.com/docs/ai-observability/installation/eve`. This spec uses
> them (rev 2).

## 2. Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Composio architecture | Official **`@composio/experimental/eve` provider** (native eve `defineTool`s from `defineComposioTools(session)`) | First-party eve integration; no hand-rolled wrappers, no MCP hop |
| Composio toolkits (v1) | Google Calendar + Gmail + Todoist (+ Tool Router meta-tools) | The personal-ops triad |
| Composio action level | Full read-write with **`requireApprovalForTools`** on mutating tools | User wants real actions, gated |
| Approval mechanism | `requireApprovalForTools('slug')` → eve's durable approval flow | Official eve hooks; covers direct + `COMPOSIO_MULTI_EXECUTE_TOOL` |
| anydoc invocation | **On-demand tool** (`parse_document`) | Model decides; no forced parsing of every attachment |
| Observability | **PostHog Cloud** via official eve install (`@posthog/ai` + `registerOTel` in `agent/instrumentation.ts`) | Smart-trace analytics, zero extra infra |
| Deployment | In-process, single `ei.service`; no new processes | Matches existing ops |
| Secrets | Env-var names only (Doppler), never values in code/DB/Discord/repo | Strict Doppler policy from slice 1 |

## 3. Architecture

Six files / one evals addition; everything else unchanged:

```
packages/agent/
├── agent/
│   ├── composio-session.ts       # Composio client + EveProvider + session
│   ├── tools/composio.ts          # defineComposioTools(session) → eve tools
│   ├── tools/parse_document.ts    # anydoc tool
│   └── instrumentation.ts         # defineInstrumentation + registerOTel
└── docs/ENV.md                    # + 3 vars
```

### 3.1 Composio — official eve provider (Unit A)

- Deps: `@composio/core` + `@composio/experimental/eve` (plus existing `eve`,
  `@ai-sdk/openai`).
- `agent/composio-session.ts`:
  - `new Composio({ provider: new EveProvider() })`, API key from
    `COMPOSIO_API_KEY` (missing → no session; agent boots, tools just error
    clearly).
  - `composio.sessions.create(ownerId, { toolkits: ['googlecalendar',
    'gmail', 'todoist'] })` — `ownerId` = `AGENT_OWNER_DISCORD_ID` (single
    user; a `(ctx)` resolver is the multi-user option, not this slice).
- `agent/tools/composio.ts`:
  - `export default defineComposioTools(session)` — a `step.started` dynamic
    resolver returning eve-native tools: the Tool Router meta-tools
    (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL`,
    `COMPOSIO_MANAGE_CONNECTIONS`) plus the preloaded Calendar/Gmail/Todoist
    toolkits. Registered as a tool-file default export → eve discovers it.
  - **Approvals:** `new EveProvider({ needsApproval:
    requireApprovalForTools('GOOGLECALENDAR_EVENTS_DELETE', …) })` — exact
    mutating-slug allowlist (events create/update/delete, Gmail send/trash/
    move, Todoist create/update/complete/delete); reads never prompt. This
    protects direct calls and matching entries in
    `COMPOSIO_MULTI_EXECUTE_TOOL`.
- Hooks (scope guardrail): pass `hooks` to deny `remoteBash`/remote
  workbench meta-tools (none are in scope), so `search`/`manageConnections`/
  `execute` remain the only meta-tools; `onAuthLink` is satisfied by a
  chat-visible link (see §6).
- Toolkit versions: `EveProvider`/the eve provider handles tool formatting
  for the agent (no `dangerouslySkipVersionCheck` needed); the plan confirms
  the exact session/toolkit API at implementation.

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

Official eve instrumentation (posthog.com/docs/ai-observability/installation/eve):

- Deps: `@posthog/ai`, `@opentelemetry/api`,
  `@opentelemetry/exporter-trace-otlp-http`,
  `@opentelemetry/sdk-trace-base`, `@vercel/otel`.
- `export default defineInstrumentation({ setup: ({ agentName }) =>
  registerOTel({ serviceName: agentName, spanProcessors: [new
  SimpleSpanProcessor(new PostHogTraceExporter({ projectToken:
  process.env.POSTHOG_PROJECT_TOKEN!, host: process.env.POSTHOG_HOST }))] }) })`.
- `events: { 'step.started' }` sets the PostHog distinct id from
  `session.auth.initiator?.principalId ?? session.auth.current?.principalId`
  as span attribute `posthog.distinct_id` + runtimeContext.
- Env: `POSTHOG_PROJECT_TOKEN` (project token, not API key — `7.19.6+`) and
  `POSTHOG_HOST` (default `https://us.i.posthog.com`). Missing
  `POSTHOG_PROJECT_TOKEN` → `setup` no-ops (guard), agent unchanged; exporter
  failure never fatal.

## 4. Data flow

- Discord → gateway → `/intake` or `/interact` → turn (unchanged).
- Model calls Composio tooling (Tool Router meta-tools or the preloaded
  Calendar/Gmail/Todoist tools) → wrapper executes against Composio → result
  rendered to text → model answers. `requireApprovalForTools` mutating slugs
  pause on eve's approval flow.
- Model decides to call `parse_document` on an attachment → bytes → Markdown
  → model saves/summarizes via innernet as before.
- Every model call / tool call / channel request emits OTel spans → PostHog
  (with channel/guild/thread runtime context).

## 5. Configuration

| Variable | Purpose |
| --- | --- |
| `COMPOSIO_API_KEY` | Composio SDK key |
| `POSTHOG_PROJECT_TOKEN` | PostHog project token (`@posthog/ai` 7.19.6+; `apiKey` before) |
| `POSTHOG_HOST` | optional; default `https://us.i.posthog.com` |

Owner id reused from `AGENT_OWNER_DISCORD_ID`. All three set in Doppler;
`docs/ENV.md` updated.

## 6. Error handling

- Composio: typed SDK errors + rendered text; missing `COMPOSIO_API_KEY` →
  clear "disabled" error (session not created); auth links surfaced via the
  `onAuthLink` hook as a chat-visible link (never in memory); no secrets
  surfaced.
- anydoc: typed `ConvertErrorCode` → friendly message.
- PostHog: exporter failure non-fatal; agent keeps running.
- All three degrade individually; the agent boots and answers with none of
  the new keys.

## 7. Testing

- **Unit (bun test):** composer session/toolkit wiring (missing key → no
  session, tools disabled), `requireApprovalForTools` slug selection, meta-tool
  hook deny guards, `parse_document` schema/errors/oversize, instrumentation
  `setup` no-ops without `POSTHOG_PROJECT_TOKEN` and calls `registerOTel`
  with it.
- **Boot smoke:** boots with no new keys; `eve info`/tool listing shows the
  composio + parse_document + instrumentation surfaces; `POSTHOG_*` set
  initializes without crash.
- **Evals:** `tools-registered` (model can see/name the tool categories).
- **Live E2E (user credentials):** Google/Todoist connected via Composio,
  real PostHog; "create a task", "what's on my calendar", "send this draft"
  (approval), a doc attachment parsed; trace visible in PostHog.

## 8. Deployment

- `bun add` in `packages/agent`: `@composio/core`, `@composio/experimental`,
  `@firecrawl/anydoc`, `@posthog/ai`, `@opentelemetry/api`,
  `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-trace-base`,
  `@vercel/otel`.
- No new units/processes; same `ei.service` (`doppler run -- bunx eve start`).
- `@vercel/otel` is a required peer of the official PostHog eve install
  (bundled as a dep, then imported from `agent/instrumentation.ts`).

## 9. Scope guardrails (locked)

- Only the whitelisted Composio surface is exposed: Calendar/Gmail/Todoist
  toolkits + Tool Router meta-tools (`search`, `manageConnections`,
  `execute`); `remoteBash`/`remoteWorkbench` meta-tools denied via hooks;
  no arbitrary tool injection beyond the session toolkits.
- `requireApprovalForTools` on every mutating slug; reads never prompt.
- `recordInputs`/`recordOutputs` default true; flip `recordInputs: false` if
  the user wants message payloads out of PostHog.
- No meeting transcription, no email autosend rules, no scheduled jobs
  driving Composio, no multi-user in this slice.

## 10. Non-goals / deferred

- Dedicated Todoist/TickTick connection (dropped).
- Self-hosted Composio MCP server or hosted-MCP-connection mode (C/B of the
  options).
- Self-hosted PostHog (Cloud chosen).
- Wider Composio surface (only the Calendar/Gmail/Todoist toolkits + Tool
  Router meta-tools now; more toolkits = more session toolkits later).

## 11. Success criteria

From Discord, with approvals on writes:
1. "Create a task …" and "check my calendar" work.
2. "Send this draft …" works, gated by approval.
3. A `.docx`/`.pdf`/`.pptx` attachment is parsed and answerable.
4. Every model call shows up as a trace in PostHog (with the owner as
   `posthog.distinct_id`).
5. The agent boots and answers with none of the new keys configured.
