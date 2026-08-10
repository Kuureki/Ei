# Personal Agent: Memory Core (Slice 1) — Design

Status: approved by user on 2026-08-10
Author: brainstorm session (user + Droid)
Repo: /root/dev/projects/Ei

## 1. Vision and scope

Long-term vision: a personal agent that eventually covers four areas: personal ops (tasks, calendar, reminders), coding companion, autonomous scheduled work, and a memory/knowledge core.

This spec covers **slice 1: the memory core** — a personal knowledge base the user can dump thoughts, links, code, files, and documents into, and query later, through Discord.

Explicitly **out of scope** for this slice (later slices, not built here):
- Task/calendar/email management
- Coding-in-repo work
- Scheduled autonomous jobs (the framework supports schedules, but no scheduled jobs ship in this slice)
- Web/chat UI beyond Discord's reply surface
- Contributions to the eve registry (our own registry is not needed in v1)

## 2. Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Framework | eve (open source, self-hosted runtime) | User wants plumbing handled, code on top. Not greenfield. |
| Memory provider | innernet.live, MCP-native | User-selected. innernet handles versioning, consolidation, retrieval, per-row privacy. |
| Surface | Discord, **custom gateway channel** | User lives in Discord; needs free-text, inline files, voice memos. Built-in Discord channel is HTTP-interactions only and supports no inbound attachments. |
| Deployment | User's own server, Docker Compose, no public inbound endpoint | Gateway connects out to Discord; no webhook, no domain/TLS needed. |
| Models | Cloud APIs (OpenAI / Anthropic / Google) | User's choice; no local GPU requirement. |
| Auth model | Single owner: agent serves exactly one Discord user id | Personal agent; reject all other principals. |
| Interaction | Free-typed messages in Discord (plus replies to the bot) | Matches how a personal assistant feels; enabled by the gateway approach. |

## 3. Architecture

```
Your server (closed, no inbound)
├── eve runtime (Node 24+, durable execution, PostgreSQL, Docker sandbox)
│   ├── agent/channels/discord.ts        custom defineChannel: intake route + delivery events
│   ├── agent/connections/innernet.ts    defineMcpClientConnection → https://innernet.live/api/mcp
│   ├── agent/tools/fetch_page.ts        URL → readable markdown
│   ├── agent/tools/transcribe_audio.ts  voice memo → text (Whisper-class cloud API)
│   ├── agent/instructions.md            capture-vs-ask judgment, citing, voice
│   └── evals/                           memory scenarios
└── discord-gateway connector (in-process with the runtime; user-owned code)
    ├── Discord gateway WebSocket client (intents: guilds, guild messages,
    │   message content, direct messages)
    ├── normalizes inbound → send([text, file parts...]) via the intake route
    ├── downloads attachments from Discord CDN using the bot token
    └── posts replies + typing via Discord REST
```

### 3.1 Custom Discord channel (`agent/channels/discord.ts`)

- Built with `defineChannel` from `eve/channels`.
- One intake route, `POST /eve/v1/discord`, consumed by the connector (loopback, plus a shared secret header).
- Inbound messages carry `UserContent`: text parts plus `{ type: "file", data: <bytes>, mediaType }` parts for attachments. eve stages bytes to the sandbox and hydrates files for the model (documented contract).
- Continuation tokens encode Discord channel + guild/thread + message id so every conversation maps to a durable session that resumes across restarts and interleaved messages.
- Auth: the route maps the invoking Discord user id to `principalType: "user"`; any other user id is dropped (`null` dispatch). Attributes carry guild/channel ids for tools and memory metadata.
- Delivery: the channel's `message.completed` event hands the reply to the connector; `turn.started` triggers typing. Replies are split at Discord's 2000-char limit. `allowed_mentions: { parse: [] }` to avoid pinging others.
- HITL in v1: plain-text confirmation inside a reply ("Say yes to save"). Buttons/modals are a post-v1 upgrade; the custom contract supports components later without redesign.

### 3.2 discord-gateway connector (user-owned, ~a few hundred lines)

- Lives in-process with the eve runtime so the deployment is one service. If the runtime process model proves awkward, it becomes a small sidecar that talks to the same intake route (decision noted under Risk 7; both are local loopback).
- Connects to Discord's gateway (WS) with `MESSAGE_CONTENT` intent (privileged; acceptable for a personal server-owned bot).
- Handles the standard bot lifecycle: connect, heartbeat, resume, reconnect with backoff, identify with intents.
- On message: if it is not from the owner in an allowed scope, drop. Download attachments (image/*, application/pdf, audio/*, text/*) from the Discord CDN using the bot token; cap at 10 MB per file.
- Forwards normalized input to the intake route; receives events for outbound replies and typing; posts via Discord REST with 429 backoff.

### 3.3 innernet connection (`agent/connections/innernet.ts`)

```
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://innernet.live/api/mcp",
  description: "Personal memory: captures, notes, links, decisions.",
  auth: {
    getToken: async () => ({ token: process.env.INNERNET_KEY! }),
  },
});
```

- Tools surface to the model as `innernet__<tool>`; credentials never reach the model or conversation history.
- The exact tool list is discovered at runtime via `connection_search` and enumerated during implementation (commit 2) against innernet's live MCP server; writes expected to include the memory-save/create tools, queries the search tools.
- Approval policy: v1 uses no per-call approval for innernet tools (personal, single-owner agent). A `once()` approval on memory-write tools is a documented, opt-in hardening step; revisit after first real use.
- If innernet's endpoint requires interactive OAuth rather than a static app token, switch `getToken` to `defineInteractiveAuthorization` (self-hosted OAuth, no Vercel) — same file, no architectural change.

### 3.4 Tools (`agent/tools/`)

- `fetch_page`: input URL; fetches the page, converts to readable markdown (reader-mode style); hands the text to the model for summarization/memory. Only for http(s) URLs; no localhost/private ranges (SSRF guard in tool description and validation).
- `transcribe_audio`: input file bytes/URL; calls the configured Whisper-class cloud API; returns transcript text.
- Images and PDFs need no extraction tool: eve hydrates the file into the sandbox and the multimodal cloud model reads them directly.
- Tools are registered by filename per eve convention (no registration ceremony).

### 3.5 Behavior (`agent/instructions.md`)

- Capture rule: save when the message adds durable knowledge (thought, decision, fact, resource, snippet). Ask before saving only when ambiguous.
- Query rule: for questions, **search innernet first**; answer from retrieved memory with citations; if nothing relevant, say "not in memory" rather than inventing.
- Voice: warm, plainspoken, no jargon. Lead with the answer.
- Metadata to attach to saves: source (discord), capture type (text/link/code/doc/audio/image), timestamp, originating channel/thread.

## 4. Data flow

### 4.1 Capture

Discord message (text and/or attachments) → connector → CDN download (files) → normalizes into `UserContent` → intake route → durable turn → model context includes hydrated files (audio is transcribed first) → agent decides capture → calls `innernet__<save>`-style tool with content + metadata → replies with confirmation and a snippet.

### 4.2 Query

Message reads as a question → agent calls `innernet__<search>`-style tool → ranks results, cites them → replies in Discord. Non-match answers with "not in memory" (enforced in instructions and evals).

### 4.3 Session model

Per-thread durable sessions: a Discord thread/channel conversation continues across restarts, interleaved messages, and deployment updates. Messages referencing the bot by reply continue the same session.

## 5. Error handling

- **innernet unreachable**: the agent replies honestly ("memory is down, try again in a bit") and may retry once; the durable runtime parks transient failures and resumes.
- **Discord gateway drop**: standard resume with token + sequence, backoff; connector reports health via logs. Attachments queued while disconnected are dropped with an explanatory notice (per-message, not silently).
- **Model/API errors**: durable retry, then a clear failure reply.
- **Oversize or unsupported files**: reject with a message listing accepted types and the 10 MB cap; never silently skip.
- **Discord REST 429s**: exponential backoff; gateway is unaffected.
- **Unknown users**: dropped silently (auth gate), no reply, nothing stored.

## 6. Testing

- **Unit**: normalization (message → `UserContent`, continuation tokens), tool input validation, SSRF guard on `fetch_page`, transcript wiring.
- **Integration**: harness feeds sample Discord payloads to the agent with a stub model; asserts expected innernet tool calls and replies.
- **Evals (eve-native, `evals/`)**: remember-then-recall same-session and cross-session; link capture; PDF capture; voice memo capture (transcription path); no-fabrication on out-of-memory questions; citation presence.
- **Manual**: run via eve TUI with the HTTP channel against real innernet before the connector lands.
- Evals gate every deploy (and can be scheduled).

## 7. Build order

1. **Scaffold**: `npx eve@latest init`, runtime up, TUI/HTTP channel smoke test, Postgres + Docker sandbox, instructions draft.
2. **Memory plumbing**: innernet MCP connection; text capture and query via curl against the HTTP channel; enumerate innernet tools; first evals (remember/recall, no-fabrication). **Verification spike**: confirm the intake/HTTP path supports file parts; fallback is the custom `defineChannel` intake route (already documented for files).
3. **Tools**: `fetch_page` (with SSRF guard), `transcribe_audio`; integration tests.
4. **Discord surface**: connector + custom channel; free-text, attachments, typing, replies, owner auth gate; end-to-end capture and query in real Discord.
5. **Harden**: approval option on memory writes, rate-limit behavior, 2000-char splitting on all paths, deployment docs, docker-compose, systemd; final evals green.

## 8. Deployment

- One Docker Compose stack on the user's server: eve runtime, PostgreSQL (durable state), Docker sandbox, connector in-process.
- Environment: `DISCORD_BOT_TOKEN`, `INNERNET_KEY`, model API key(s), `AGENT_OWNER_DISCORD_ID`.
- No public inbound: gateway connects out; the intake route is loopback-only, bound on the runtime's internal network.
- Restarts: systemd `Restart=always`; eve durable execution resumes sessions.

## 9. Security and privacy

- Single-owner: every dispatch is gated on the owner's Discord id; non-owners never reach the model or memory.
- Credentials: bot token and innernet key live in env/secrets, never in the model context; eve's connection layer keeps them out of conversation history.
- innernet is a **hosted third party**: captures and queries flow to innernet's servers (and cloud model APIs). Row-level privacy, hashed tokens, and OAuth are innernet's guarantees; acceptable to the user. Disclose prompts: user is responsible for what is saved.
- Bot scope: gateway bot created for this personal use; intents limited to what is needed; server membership limited to the owner's servers.
- Discord privacy: `allowed_mentions { parse: [] }`; no message content logging beyond what eve persists for sessions.

## 10. Risks and open items

1. **eve is in beta**: API surface may shift during the build; pin versions, review release notes, and keep the spec's seams (connection, channel, tools) intact so churn stays localized.
2. **innernet MCP tool surface unknown until wired**: enumeration in commit 2; if its MCP tools are read-heavy or OAuth-gated, fallback is app-scoped REST writes via a small tool, keeping MCP for queries (escalation only, flagged to user).
3. **Discord MESSAGE_CONTENT intent**: privileged but normal for a personal bot; approve in the Discord developer portal; no user-consent complications for a single-owner server bot.
4. **Voice memos**: Discord voice messages arrive as ogg/opus attachments; transcription accuracy depends on the chosen Whisper-class API; tech-debt note if quality is poor (local Whisper later).
5. **Long attachments**: capped at 10 MB; larger docs must be linked (URL capture) or split.
6. **Connector process model**: in-process with the runtime preferred; sidecar fallback if event handling is awkward (Risk marked for spike at step 4). No public exposure either way.
7. **Accidental capture flood**: screenshots and memes in busy channels must not create memory noise; instructions.md defines a conservative capture trigger (save on explicit ask, decisions, durable facts, resources worth keeping). If noise persists, add UIs-level filters or an allowlist of channels (post-v1).
8. **Cost**: cloud APIs per-use; transcriptions and fetches are the main variable costs. Envelope: estimate during evals; add budgets/monitoring in step 5 if needed.

## 11. Success criteria for this slice

- Dump a thought, a link, a code snippet, a PDF, an image, and a voice memo from Discord; ask about each later and get cited answers from memory.
- No fabrication: out-of-memory questions get "not in memory".
- Runs unattended on the user's server, survives restarts, sessions continue.
- All evals green before and after every change.
