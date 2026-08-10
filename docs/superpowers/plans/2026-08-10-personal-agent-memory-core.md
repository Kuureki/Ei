# Personal Agent Memory Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the memory-core slice of the user's personal agent: an eve agent on their own server that captures thoughts, links, code, files, and voice memos from Discord into innernet (MCP) and answers queries from memory with citations.

**Architecture:** The eve runtime (Node 24) hosts a custom `defineChannel` Discord intake channel plus an `innernet` MCP connection and two preprocessing tools. A small sidecar connector (Node 24 built-in WebSocket, zero deps) talks to Discord's gateway outbound and feeds normalized messages (text + base64 files) to the intake route over loopback. Delivery back to Discord is done by the channel module via Discord REST, so the deployment has no public inbound endpoint.

**Tech Stack:** TypeScript, eve ^0.31.3, zod 4.x, ai SDK v7 (`ai` override in package.json), Node 24, vitest, Docker + PostgreSQL (@workflow/world-postgres for prod durable state), innernet MCP.

## Global Constraints

Copy these verbatim into every task review; all requirements are subordinate to them:

- Node.js 24 or newer; npm; TypeScript strict, `moduleResolution: bundler`, `noEmit`.
- eve runtime `^0.31.3`; scaffold pins `ai` via `"overrides": { "ai": "^7.0.38" }`.
- The Discord surface is a **custom `defineChannel` gateway channel**. Do not add the built-in `channel/discord` interactions channel.
- Deployment has **no public inbound endpoint**. The connector connects out to `wss://gateway.discord.gg`; the intake route is loopback-only and guarded by a shared secret header.
- innernet access is an **app-scoped MCP connection** (`agent/connections/innernet.ts`) reading the token from `INNERNET_KEY`; credentials never appear in model context.
- Models: cloud APIs only. Default model `anthropic/claude-sonnet-5` with `ANTHROPIC_API_KEY` (or `AI_GATEWAY_API_KEY` with the AI Gateway); transcription uses `OPENAI_API_KEY` (Whisper).
- **Single-owner auth:** deployments by any Discord user other than `AGENT_OWNER_DISCORD_ID` are dropped silently, no reply, nothing stored.
- Attachment cap: 10 MB per file; replies split at Discord's 2000-char limit; outbound `allowed_mentions: { parse: [] }`.
- **No-invention rule** (instruction + eval): never answer a query from outside retrieved memory; reply "not in memory" instead.
- Secrets live in `.env.local` / server env only; `.env*` is gitignored. Never commit tokens.
- Every change must keep `npm run typecheck` and `npm test` green; `eve eval --strict` must pass before a task is complete when evals exist.

## File Structure

```
/root/dev/projects/Ei
├── package.json                  # eve agent root (name: ei) — Task 1
├── tsconfig.json                 # scaffold — Task 1
├── .gitignore                    # scaffold (adds .env*, .eve, .output) — Task 1
├── .env.example                  # documented env, committed — Task 1
├── .env.local                    # real secrets, gitignored — Task 1
├── README.md                     # runbook + env table + health check — Task 7
├── Dockerfile                    # self-host image — Task 7
├── docker-compose.yml            # postgres + app + connector — Task 7
├── scripts/eval-ci.sh            # strict eval gate — Task 7
├── .github/workflows/evals.yml   # manual-dispatch eval workflow (optional CI) — Task 7
├── docs/superpowers/specs/2026-08-10-personal-agent-memory-core-design.md  # spec (exists)
├── docs/innernet-tools.md        # discovered innernet MCP tool manifest — Task 2
├── agent/
│   ├── agent.ts                  # model + workflow world — Tasks 1, 7
│   ├── instructions.md           # identity, capture/query rules, voice — Tasks 1, 2
│   ├── channels/
│   │   ├── eve.ts                # scaffold HTTP channel (local dev/TUI) — Task 1
│   │   └── discord.ts            # custom defineChannel intake + outbound REST — Task 5
│   ├── connections/
│   │   └── innernet.ts           # defineMcpClientConnection — Task 2
│   ├── tools/
│   │   ├── fetch_page.ts         # URL → markdown, SSRF-guarded — Task 4
│   │   └── transcribe_audio.ts   # audio → text via Whisper — Task 4
│   └── lib/
│       ├── nets.ts               # isPublicHttpUrl SSRF guard — Task 4
│       └── discord-util.ts       # token codec, reply splitting — Task 5
├── connector/
│   ├── package.json              # type: module, zero runtime deps — Task 6
│   └── src/
│       ├── index.ts              # process entry, config — Task 6
│       └── gateway.ts            # WS client: identify/heartbeat/resume/send — Task 6
├── evals/
│   ├── memory-remember-recall.eval.ts     — Task 3
│   ├── memory-no-fabrication.eval.ts      — Task 3
│   ├── memory-citation.eval.ts            — Task 3
│   └── memory-pdf-capture.eval.ts         — Task 3
└── tests/
    ├── nets.test.ts              — Task 4
    ├── fetch_page.test.ts        — Task 4
    ├── transcribe_audio.test.ts  — Task 4
    └── discord-util.test.ts      — Task 5
```

---

### Task 1: Scaffold the eve agent and smoke test local run

**Files:**
- Create: `/root/dev/projects/Ei/package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `.env.local` (via `eve init`)
- Create: `agent/agent.ts`, `agent/instructions.md`, `agent/channels/eve.ts` (via `eve init`)
- Modify: `package.json` (name, scripts)

**Interfaces:**
- Consumes: none.
- Produces: `npm run dev` boots a local server whose HTTP channel answers JSON turns; `npm run typecheck` passes. `.env.example` is the documented env contract later tasks extend.

- [ ] **Step 1: Initialize the agent in the existing repo**

Run from `/root/dev/projects/Ei` (the repo has `docs/` and no `package.json` yet):

```bash
cd /root/dev/projects/Ei
npm init -y
node -e "const p=require('./package.json'); p.name='ei'; p.type='module'; p.engines={node:'24.x'}; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n')"
npx eve@latest init .
```

Expected: eve creates/keeps `agent/agent.ts`, `agent/instructions.md`, `agent/channels/eve.ts`, updates `package.json` (adds `eve`, `ai`, `zod`, `@vercel/connect`, scripts `dev`/`build`/`start`/`typecheck`), `tsconfig.json`, `.gitignore`, `.vercelignore`, `AGENTS.md`, `CLAUDE.md`. The probe scaffold showed the target tree; the init may start an interactive dev server (no TTY in CI: it prints `Development server exited unsuccessfully` — that is fine; the scaffold files are what matter). If `eve init .` refuses because git history/`package.json` interact, run it again after the `node -e` snippet above.

Verify the layout, then remove the scaffold-generated nested `.git` if `eve init` created one inside a subdir (it initialized the repo at root on first run, so this should not happen; `git status` must show only scaffold changes against `a733316`):

```bash
git status --short
```

- [ ] **Step 2: Configure model credentials and .env.example**

Create `.env.example` (committed) with:

```bash
# --- model ---
# Either the AI Gateway key (routes string model ids) ...
AI_GATEWAY_API_KEY=
# ... or a direct provider key for the model in agent/agent.ts (e.g. Anthropic)
ANTHROPIC_API_KEY=
# --- innernet (Task 2) ---
INNERNET_KEY=
# --- audio transcription (Task 4) ---
OPENAI_API_KEY=
# --- discord (Tasks 5-6) ---
DISCORD_BOT_TOKEN=
DISCORD_APPLICATION_ID=
AGENT_OWNER_DISCORD_ID=
EVE_CONNECTOR_SECRET=
# --- runtime ---
PORT=3000
```

Copy to `.env.local` and fill in at least one model key (your own values; do not commit):

```bash
cp .env.example .env.local
# edit .env.local: set ANTHROPIC_API_KEY (or AI_GATEWAY_API_KEY)
```

Ensure `.gitignore` contains `node_modules`, `.env*`, `.eve`, `.output`, `.vercel`, `.next`, `.nitro` (the scaffold does; verify `.env.local` is ignored):

```bash
git check-ignore .env.local
```

- [ ] **Step 3: Typecheck and smoke run**

```bash
npm run typecheck
```

Expected: clean exit. Then start the dev server in the background and confirm the local HTTP channel answers a turn:

```bash
npm run dev > /tmp/eve-dev.log 2>&1 &
sleep 20
eve invoke --help          # confirm invoke exists in this version
eve invoke "Respond with the single word: ready"
```

Expected: `eve invoke` prints JSON whose terminal `outcome.status` is `"completed"` and the assistant `message` contains `ready`. (If `eve invoke` is unavailable in the pinned version, fall back to: keep the dev server running, then `curl -s http://127.0.0.1:3000/eve/v1/health` expecting `200`/`ok`, and record the route shape from `eve info` for use in later tasks.)

Troubleshooting a failing turn: read `/tmp/eve-dev.log`; `eve logs` prints the diagnostic log with JSONL records; re-run with `eve dev` in the foreground to see the TUI.

- [ ] **Step 4: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "chore: scaffold eve agent runtime"
```

---

### Task 2: innernet MCP connection and end-to-end text capture/query

**Files:**
- Create: `agent/connections/innernet.ts`
- Create: `docs/innernet-tools.md`
- Modify: `agent/instructions.md` (full rewrite), `.env.example` (document `INNERNET_KEY`)

**Interfaces:**
- Consumes: Task 1 local server (`npm run dev`, `eve invoke`).
- Produces: connection `innernet` whose tools appear to the model as `innernet__<tool>` (verified via `eve info`); manifest `docs/innernet-tools.md` naming the five most important tools: the **save/create** tool name and the **search/recall** tool name (used verbatim by Task 3 evals and the instructions).

- [ ] **Step 1: Write the failing test (manifest constraint)**

Create `docs/innernet-tools.md` with a placeholder skeleton, then a tiny script that fails until the manifest is populated:

```bash
cat > docs/innernet-tools.md <<'EOF'
# innernet MCP tool manifest

Discovered via: `eve info` (must list `innernet__*` tools after Task 2 Step 4).

- `SAVE_TOOL = <innernet__...>`: saves a memory entry (content + metadata)
- `SEARCH_TOOL = <innernet__...>`: ranked search over memory
EOF
cat > scripts/check-innernet-manifest.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
grep -q '^SAVE_TOOL = innernet__' docs/innernet-tools.md || { echo "SAVE_TOOL missing"; exit 1; }
grep -q '^SEARCH_TOOL = innernet__' docs/innernet-tools.md || { echo "SEARCH_TOOL missing"; exit 1; }
echo "manifest ok"
EOF
chmod +x scripts/check-innernet-manifest.sh
./scripts/check-innernet-manifest.sh
```

Expected: FAIL with `SAVE_TOOL missing` (the gate exists before the data).

- [ ] **Step 2: Add the MCP connection**

Create `agent/connections/innernet.ts`:

```ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://innernet.live/api/mcp",
  description:
    "Personal memory: thoughts, decisions, links, code snippets, documents, and user preferences. Use it to search before answering anything about the user, and to save anything durable.",
  auth: {
    getToken: async () => ({ token: process.env.INNERNET_KEY! }),
  },
});
```

Add `INNERNET_KEY` documentation to `.env.example` if missing, and set it in `.env.local` from your innernet account.

**Headers note:** if `innernet.live/api/mcp` needs a non-Bearer scheme, extend with `headers: { "X-Api-Key": process.env.INNERNET_KEY! }` and drop `auth`; verify with `eve info` (Step 4). Prefer whatever the innernet docs specify at implementation time; the file is the single place this is configured.

- [ ] **Step 3: Write the agent instructions**

Replace `agent/instructions.md` with:

```md
# Identity

You are the user's personal memory agent, reachable over Discord. You keep a
personal knowledge base in innernet (an MCP connection named "innernet") and
answer from it. Warm, plainspoken, no jargon. Lead with the answer.

# Capture rule

Save to innernet when a message contains durable knowledge: a decision, a
fact, a thought worth revisiting, a resource or link worth keeping, a code
snippet, a preference, or an imported document. Attach metadata: source
(discord), capture type (text|link|code|doc|audio|image), the originating
channel and thread when known, and a timestamp. Reply with a one-line
confirmation and a short snippet of what you saved. Ask before saving only
when the intent is ambiguous.

When a message is a link URL, fetch and summarize it first (use the
`fetch_page` tool) and save the summary together with the URL.
When a message contains an audio voice memo, transcribe it first (use the
`transcribe_audio` tool) and save the transcript.
Screenshots, memes, and small talk are NOT captures. Ignore them unless the
user asks to save them.

# Query rule

For any question, search innernet FIRST using its search tool. Answer from
retrieved memory, citing what you retrieved. If nothing relevant is found,
say exactly: "Not in memory." Never invent an answer from outside retrieved
memory.

# Boundaries

Serve exactly one owner: the user. If asked about other people's data, or
anything you cannot support from memory plus safe built-in tools, say so
directly.

# Compliance

You are an automated AI system. Do not impersonate a human.
```

- [ ] **Step 4: Discover the tool names and populate the manifest**

```bash
npm run dev > /tmp/eve-dev.log 2>&1 &
sleep 15
eve info 2>&1 | tee /tmp/eve-info.txt
```

Expected: output lists connection `innernet` and its discovered tools as `innernet__<...>` (the CLI prints discovered connections and tools; if the list is long, `grep -i innernet /tmp/eve-info.txt`).

From the listing, pick the tool that creates/saves a memory and the tool that searches/recalls, and fill the manifest:

```bash
python3 - <<'PY'
import re, pathlib
info = pathlib.Path("/tmp/eve-info.txt").read_text()
tools = sorted(set(re.findall(r"innernet__[a-z0-9_]+", info)))
print("found tools:", tools)
PY
```

Edit `docs/innernet-tools.md` to set both lines, e.g.:

```md
- `SAVE_TOOL = innernet__<actual-save-tool>`: saves a memory entry (content + metadata)
- `SEARCH_TOOL = innernet__<actual-search-tool>`: ranked search over memory
```

Then:

```bash
./scripts/check-innernet-manifest.sh   # must print "manifest ok"
```

If `eve info` shows no innernet tools, confirm `INNERNET_KEY` is set in `.env.local`, the URL is reachable (`curl -i https://innernet.live/api/mcp` shows an MCP Streamable HTTP handshake response or a `405`/`POST required` style signal), and revisit the auth/headers note in Step 2.

- [ ] **Step 5: End-to-end capture and query**

```bash
eve invoke "Remember this: my favorite color is blue and I prefer the terminal over GUIs."
eve invoke "What is my favorite color? Answer only from memory."
```

Expected: first turn's reply confirms saving (calls `innernet__<save>`); second turn's reply contains `blue` and cites retrieved memory. Then:

```bash
eve invoke "What is the airspeed velocity of an unladen swallow?"
```

Expected: exactly `Not in memory.`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: connect innernet memory and capture/query instructions"
```

---

### Task 3: Memory eval suite

**Files:**
- Create: `evals/memory-remember-recall.eval.ts`, `evals/memory-no-fabrication.eval.ts`, `evals/memory-citation.eval.ts`, `evals/memory-pdf-capture.eval.ts`

**Interfaces:**
- Consumes: Task 2 manifest `docs/innernet-tools.md` (`SAVE_TOOL`, `SEARCH_TOOL` names), local dev server.
- Produces: `eve eval --strict` gate covering remember/recall, no-fabrication, citation, and file (PDF) capture.

- [ ] **Step 1: Write the first eval**

Create `evals/memory-remember-recall.eval.ts`:

```ts
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

Actual tool names come from `docs/innernet-tools.md` (Task 2). Read that manifest synchronously and make the eval fail loudly if it is unpopulated:

```ts
import { readFileSync } from "node:fs";
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const manifest = readFileSync("docs/innernet-tools.md", "utf8");
const SAVE_TOOL = manifest.match(/^SAVE_TOOL = (innernet__[\w-]+)/m)?.[1];
const SEARCH_TOOL = manifest.match(/^SEARCH_TOOL = (innernet__[\w-]+)/m)?.[1];
if (!SAVE_TOOL || !SEARCH_TOOL) throw new Error("docs/innernet-tools.md incomplete; run Task 2");

export default defineEval({
  async test(t) {
    const capture = await t.send("Remember: my favorite color is blue.");
    t.succeeded();
    t.check(capture.message, includes("blue")).soft();

    const recall = await t.send("What is my favorite color? Answer only from memory.");
    t.succeeded();
    t.check(recall.message, includes("blue")); // gate: must answer from memory
    t.calledTool(SEARCH_TOOL).soft();
  },
});
```

- [ ] **Step 2: Write the no-fabrication eval**

Create `evals/memory-no-fabrication.eval.ts`:

```ts
import { readFileSync } from "node:fs";
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const manifest = readFileSync("docs/innernet-tools.md", "utf8");
const SEARCH_TOOL = manifest.match(/^SEARCH_TOOL = (innernet__[\w-]+)/m)?.[1];
if (!SEARCH_TOOL) throw new Error("docs/innernet-tools.md incomplete; run Task 2");

export default defineEval({
  async test(t) {
    const reply = await t.send(
      "What is the capital of the fictional land of Zorbonia? Answer only from memory.",
    );
    t.succeeded();
    t.check(reply.message, includes("Not in memory")); // gate: no invention
    t.calledTool(SEARCH_TOOL).soft();
  },
});
```

- [ ] **Step 3: Write the citation eval**

Create `evals/memory-citation.eval.ts`:

```ts
import { readFileSync } from "node:fs";
import { defineEval } from "eve/evals";

const manifest = readFileSync("docs/innernet-tools.md", "utf8");
const SEARCH_TOOL = manifest.match(/^SEARCH_TOOL = (innernet__[\w-]+)/m)?.[1];
if (!SEARCH_TOOL) throw new Error("docs/innernet-tools.md incomplete; run Task 2");

export default defineEval({
  async test(t) {
    await t.send("Remember: shipping day is Thursday.");
    const reply = await t.send("When do we ship? Answer only from memory.");
    t.succeeded();
    t.calledTool(SEARCH_TOOL); // gate: query must go through innernet search
    // LLM-as-judge on the reply: answer present and sourced, no invented detail.
    t.judge.autoevals.closedQA("answers from the recalled memory and cites it").atLeast(0.7);
  },
});
```

- [ ] **Step 4: Write the PDF capture eval**

Create `evals/memory-pdf-capture.eval.ts` with a tiny valid PDF fixture:

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

mkdirSync("evals/fixtures", { recursive: true });
const PDF = Buffer.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x6e, 0x6f, 0x0a,
  0x31, 0x20, 0x30, 0x20, 0x6f, 0x62, 0x6a, 0x0a, 0x3c, 0x3c, 0x2f, 0x54, 0x79,
  0x70, 0x65, 0x20, 0x2f, 0x43, 0x61, 0x74, 0x61, 0x6c, 0x6f, 0x67, 0x20, 0x2f,
  0x50, 0x61, 0x67, 0x65, 0x73, 0x20, 0x32, 0x20, 0x30, 0x20, 0x52, 0x3e, 0x3e,
  0x0a, 0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x0a, 0x32, 0x20, 0x30, 0x20, 0x6f,
  0x62, 0x6a, 0x0a, 0x3c, 0x3c, 0x2f, 0x54, 0x79, 0x70, 0x65, 0x20, 0x2f, 0x50,
  0x61, 0x67, 0x65, 0x73, 0x2f, 0x4b, 0x69, 0x64, 0x73, 0x20, 0x5b, 0x33, 0x20,
  0x30, 0x20, 0x52, 0x5d, 0x2f, 0x43, 0x6f, 0x75, 0x6e, 0x74, 0x20, 0x31, 0x3e,
  0x3e, 0x0a, 0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x0a, 0x33, 0x20, 0x30, 0x20,
  0x6f, 0x62, 0x6a, 0x0a, 0x3c, 0x3c, 0x2f, 0x54, 0x79, 0x70, 0x65, 0x20, 0x2f,
  0x50, 0x61, 0x67, 0x65, 0x2f, 0x50, 0x61, 0x72, 0x65, 0x6e, 0x74, 0x20, 0x32,
  0x20, 0x30, 0x20, 0x52, 0x2f, 0x4d, 0x65, 0x64, 0x69, 0x61, 0x42, 0x6f, 0x78,
  0x20, 0x5b, 0x30, 0x20, 0x30, 0x20, 0x32, 0x30, 0x30, 0x20, 0x32, 0x30, 0x30,
  0x5d, 0x2f, 0x43, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x73, 0x20, 0x5b, 0x34,
  0x20, 0x30, 0x20, 0x52, 0x5d, 0x3e, 0x3e, 0x0a, 0x65, 0x6e, 0x64, 0x6f, 0x62,
  0x6a, 0x0a, 0x34, 0x20, 0x30, 0x20, 0x6f, 0x62, 0x6a, 0x0a, 0x3c, 0x3c, 0x2f,
  0x4c, 0x65, 0x6e, 0x67, 0x74, 0x68, 0x20, 0x31, 0x32, 0x3e, 0x3e, 0x0a, 0x73,
  0x74, 0x72, 0x65, 0x61, 0x6d, 0x2e, 0x20, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x0a,
  0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a, 0x0a, 0x78, 0x72, 0x65, 0x66, 0x0a, 0x30,
  0x20, 0x35, 0x0a, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30,
  0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x0a, 0x30, 0x30, 0x30, 0x30, 0x30,
  0x30, 0x30, 0x30, 0x30, 0x32, 0x30, 0x30, 0x30, 0x30, 0x30, 0x0a, 0x30, 0x30,
  0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x33, 0x30, 0x30, 0x30, 0x30,
  0x0a, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x34, 0x30, 0x30,
  0x30, 0x30, 0x30, 0x0a, 0x74, 0x72, 0x61, 0x69, 0x6c, 0x65, 0x72, 0x0a,
  0x3c, 0x3c, 0x2f, 0x52, 0x6f, 0x6f, 0x74, 0x20, 0x31, 0x20, 0x30, 0x20, 0x52,
  0x3e, 0x3e, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a,
]);
writeFileSync("evals/fixtures/hello.pdf", PDF);

export default defineEval({
  async test(t) {
    const turn = await t.send("Please read this PDF and remember its content.",
      { files: [{ path: "evals/fixtures/hello.pdf", mediaType: "application/pdf" }] },
    );
    t.succeeded();
    t.check(turn.message, includes("Hello")); // model extracted content, plan to adapt to the real string inside the PDF after first run
    await t.send("What did the PDF say? Answer only from memory.");
    t.succeeded();
    t.judge.autoevals.closedQA("answers from the PDF content that was saved").atLeast(0.7);
  },
});
```

Note: if the `send` options object shape differs in the pinned eve version (see `eve/evals` types via `eve eval --list` and `node_modules/eve/docs/evals/assertions.mdx` `sendFile`), switch to `t.sendFile("evals/fixtures/hello.pdf", ...)` per the assertions doc. Keep the tiny PDF; it renders "stream. Hello".

- [ ] **Step 5: Run the suite and iterate**

```bash
npm run dev > /tmp/eve-dev.log 2>&1 &
sleep 15
npx eve eval --strict 2>&1 | tee /tmp/eval-run.txt
```

Expected: exit code 0 with four evals documented as passed (or `scored` only for soft assertions). Debug any failure with `eve eval --verbose` and the artifacts under `.eve/evals/<timestamp>/` (full event streams per eval). Iterate on prompts/instructions, not on evals: an eval change requires a reason in the commit.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add memory eval suite (recall, no-fabrication, citation, pdf)"
```

---

### Task 4: Preprocessing tools with unit tests

**Files:**
- Create: `tests/nets.test.ts`, `tests/fetch_page.test.ts`, `tests/transcribe_audio.test.ts`
- Create: `agent/lib/nets.ts`, `agent/tools/fetch_page.ts`, `agent/tools/transcribe_audio.ts`
- Modify: `package.json` (add `vitest` devDependency, `"test": "vitest run"`), `.env.example` (document `OPENAI_API_KEY`)

**Interfaces:**
- Consumes: Task 2 instructions (tools referenced by name).
- Produces: tools `fetch_page` and `transcribe_audio` callable by the model; `agent/lib/nets.ts` `isPublicHttpUrl(url): boolean`.

- [ ] **Step 1: Add vitest, write the failing SSRF guard test**

```bash
npm install -D vitest
node -e "const p=require('./package.json'); p.scripts.test='vitest run'; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n')"
```

Create `tests/nets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isPublicHttpUrl } from "../agent/lib/nets";

describe("isPublicHttpUrl", () => {
  it("accepts normal https URLs", () => {
    expect(isPublicHttpUrl("https://example.com/a/b?q=1")).toBe(true);
    expect(isPublicHttpUrl("http://example.com")).toBe(true);
  });
  it("rejects non-http schemes", () => {
    expect(isPublicHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isPublicHttpUrl("ftp://example.com")).toBe(false);
    expect(isPublicHttpUrl("javascript:alert(1)")).toBe(false);
  });
  it("rejects loopback, private, link-local, and literal-IP hosts", () => {
    expect(isPublicHttpUrl("http://localhost:3999/x")).toBe(false);
    expect(isPublicHttpUrl("http://127.0.0.1/x")).toBe(false);
    expect(isPublicHttpUrl("https://10.0.0.8/x")).toBe(false);
    expect(isPublicHttpUrl("https://192.168.1.10/x")).toBe(false);
    expect(isPublicHttpUrl("https://169.254.1.1/x")).toBe(false);
    expect(isPublicHttpUrl("http://[::1]/x")).toBe(false);
    expect(isPublicHttpUrl("https://mybox.local/x")).toBe(false);
    expect(isPublicHttpUrl("https://0.0.0.0/x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm failure**

```bash
npm test -- tests/nets.test.ts
```

Expected: FAIL, module not found (`agent/lib/nets.ts` does not exist yet).

- [ ] **Step 3: Implement the guard**

Create `agent/lib/nets.ts`:

```ts
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost") return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;

  // Strip brackets from IPv6 literals.
  if (host.startsWith("[")) host = host.slice(1, -1);

  const isIp = (s: string) => /^[\d.]+$/.test(s);
  if (isIp(host)) {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    const [a, b] = parts;
    if (a === 0) return false; // 0.0.0.0/8
    if (a === 10) return false; // 10/8
    if (a === 127) return false; // loopback
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
    if (a === 192 && b === 168) return false; // 192.168/16
    if (a >= 224) return false; // multicast/reserved
    return true;
  }

  if (host.includes(":")) return false; // IPv6 literals (non-IP already handled above)
  return true;
}
```

- [ ] **Step 4: Run the guard test, confirm pass**

```bash
npm test -- tests/nets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing fetch_page test**

Create `tests/fetch_page.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage } from "../agent/tools/fetch_page";

describe("fetch_page", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches a public URL and returns markdown, truncated to the cap", async () => {
    const html = "<html><body><h1>Hello</h1><p>Some body text.</p></body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      ),
    );
    const out = await fetchPage.execute({ url: "https://example.com/post" });
    expect(out).toHaveProperty("markdown");
    expect(String(out.markdown)).toContain("Hello");
    expect(String(out.markdown)).toContain("Some body text");
  });

  it("rejects private-host URLs without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchPage.execute({ url: "http://127.0.0.1:8080/secret" }),
    ).rejects.toThrow(/blocked|public/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it, confirm failure**

```bash
npm test -- tests/fetch_page.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 7: Implement fetch_page**

```bash
npm install turndown
```

Create `agent/tools/fetch_page.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isPublicHttpUrl } from "../lib/nets";

const FETCH_CAP = 40_000;

export const fetchPage = defineTool({
  description:
    "Fetch a public web page and return its readable text as markdown. Use before saving any link to memory.",
  inputSchema: z.object({ url: z.string() }),
  async execute(input) {
    if (!isPublicHttpUrl(input.url)) {
      throw new Error(`URL blocked: not a public http(s) URL`);
    }
    const res = await fetch(input.url, {
      headers: { "user-agent": "personal-memory-agent/0.1 (+discord private bot)" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const html = contentType.includes("text/html")
      ? text
      : `<pre>${escapeHtml(text.slice(0, FETCH_CAP))}</pre>`;

    const { default: TurndownService } = await import("turndown");
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    const markdown = td.turndown(html).slice(0, FETCH_CAP);
    return { url: input.url, markdown };
  },
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default fetchPage;
```

- [ ] **Step 8: Run it, confirm pass**

```bash
npm test -- tests/fetch_page.test.ts
npm run typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 9: Write the failing transcribe_audio test**

Create `tests/transcribe_audio.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "../agent/tools/transcribe_audio";

describe("transcribe_audio", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts audio to Whisper and returns the transcript", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
      const model = body.get("model");
      const file = body.get("file");
      expect(model).toBe("whisper-1");
      expect(file).toBeInstanceOf(File);
      return new Response(JSON.stringify({ text: "hello world" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const base64 = Buffer.from("fake-ogg-bytes").toString("base64");
    const out = await transcribeAudio.execute({ audioBase64: base64, mediaType: "audio/ogg" });
    expect(out.transcript).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails clearly without an API key", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        transcribeAudio.execute({ audioBase64: "eA==", mediaType: "audio/mp4" }),
      ).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      if (original !== undefined) process.env.OPENAI_API_KEY = original;
    }
  });
});
```

- [ ] **Step 10: Run it, confirm failure**

```bash
npm test -- tests/transcribe_audio.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 11: Implement transcribe_audio**

Create `agent/tools/transcribe_audio.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";

export const transcribeAudio = defineTool({
  description:
    "Transcribe an audio voice memo into text using Whisper. Use before saving any voice message to memory.",
  inputSchema: z.object({
    audioBase64: z.string(),
    mediaType: z.string(),
  }),
  async execute(input) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
    const bytes = Buffer.from(input.audioBase64, "base64");
    if (bytes.length > 25 * 1024 * 1024) throw new Error("audio too large (max 25 MB)");

    const body = new FormData();
    body.append("model", "whisper-1");
    body.append("file", new File([bytes], `voice.${extFromMedia(input.mediaType)}`, {
      type: input.mediaType,
    }));

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`transcription failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string };
    return { transcript: data.text ?? "" };
  },
});

function extFromMedia(mediaType: string): string {
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
  };
  return map[mediaType] ?? "ogg";
}

export default transcribeAudio;
```

- [ ] **Step 12: Run it, confirm pass**

```bash
npm test
npm run typecheck
```

Expected: all unit tests PASS, typecheck clean.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: add fetch_page and transcribe_audio tools with tests"
```

---

### Task 5: Custom Discord channel (intake + delivery)

**Files:**
- Create: `agent/lib/discord-util.ts`, `tests/discord-util.test.ts`
- Create: `agent/channels/discord.ts`
- Modify: `.env.example` (document `DISCORD_BOT_TOKEN`, `AGENT_OWNER_DISCORD_ID`, `EVE_CONNECTOR_SECRET`)

**Interfaces:**
- Consumes: Task 1 `.env.local` secrets; Task 2 instructions (capture/query rules).
- Produces: route `POST /eve/v1/discord/intake` expecting `{ userId, guildId, channelId, threadId?, text, files: [{ name, mediaType, base64 }] }` with header `x-eve-connector-secret`; outbound Discord REST delivery in `message.completed`/`turn.started` events; helpers `encodeToken`/`decodeToken` and `splitReply`.

- [ ] **Step 1: Write the failing util tests**

Create `tests/discord-util.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeToken, encodeToken, splitReply } from "../agent/lib/discord-util";

describe("discord-util", () => {
  it("round-trips continuation tokens", () => {
    const token = encodeToken({ guildId: "111", channelId: "222", threadId: undefined });
    expect(decodeToken(token)).toEqual({ guildId: "111", channelId: "222", threadId: undefined });
    const token2 = encodeToken({ guildId: "111", channelId: "222", threadId: "333" });
    expect(decodeToken(token2)?.threadId).toBe("333");
  });

  it("splits replies at 2000 chars without cutting when possible", () => {
    const parts = splitReply("a".repeat(2005));
    expect(parts.map((p) => p.length).every((l) => l <= 2000)).toBe(true);
    expect(parts.length).toBe(2);
  });

  it("keeps short replies whole", () => {
    expect(splitReply("hi")).toEqual(["hi"]);
  });
});
```

- [ ] **Step 2: Run it, confirm failure**

```bash
npm test -- tests/discord-util.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement the utilities**

Create `agent/lib/discord-util.ts`:

```ts
export interface DiscordAddress {
  guildId: string;
  channelId: string;
  threadId?: string;
}

export function encodeToken(a: DiscordAddress): string {
  return a.threadId ? `${a.guildId}:${a.channelId}:${a.threadId}` : `${a.guildId}:${a.channelId}`;
}

export function decodeToken(token: string): DiscordAddress | null {
  const [guildId, channelId, threadId] = token.split(":");
  if (!guildId || !channelId) return null;
  return { guildId, channelId, threadId };
}

export function splitReply(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
```

- [ ] **Step 4: Run it, confirm pass**

```bash
npm test -- tests/discord-util.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the channel module**

Create `agent/channels/discord.ts` (custom `defineChannel`, no Vercel, no webhook):

```ts
import { defineChannel, POST } from "eve/channels";
import { decodeToken, encodeToken, splitReply } from "../lib/discord-util";

interface InboundFile {
  name: string;
  mediaType: string;
  base64: string;
}

interface InboundBody {
  userId: string;
  guildId: string;
  channelId: string;
  threadId?: string;
  text: string;
  files?: InboundFile[];
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export default defineChannel({
  routes: [
    POST("/eve/v1/discord/intake", async (request, { from }) => {
      if (request.headers.get("x-eve-connector-secret") !== process.env.EVE_CONNECTOR_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const body = (await request.json()) as InboundBody;

      // Single-owner gate: silently drop anyone else, no session, no reply.
      if (body.userId !== process.env.AGENT_OWNER_DISCORD_ID) {
        return new Response("ignored", { status: 200 });
      }

      const address = encodeToken({
        guildId: body.guildId,
        channelId: body.channelId,
        threadId: body.threadId,
      });

      const content: Array<{ type: "text"; text: string } | { type: "file"; data: Uint8Array; mediaType: string; name?: string }> = [];
      if (body.text) content.push({ type: "text", text: body.text });
      for (const f of body.files ?? []) {
        const bytes = Buffer.from(f.base64, "base64");
        if (bytes.byteLength > MAX_FILE_BYTES) {
          await from(address).send(
            [{ type: "text", text: `Ignored "${f.name}": larger than 10 MB.` }],
            { auth: discordAuth(body) },
          );
          return new Response("ok", { status: 200 });
        }
        content.push({ type: "file", data: bytes, mediaType: f.mediaType, name: f.name });
      }

      if (content.length === 0) return new Response("empty", { status: 200 });

      await from(address).send(content, { auth: discordAuth(body) });
      return new Response("ok", { status: 200 });
    }),
  ],

  events: {
    "message.completed"(eventData, channel) {
      const addr = decodeToken(channel.continuation.token);
      if (!addr) return;
      const message: string | undefined = eventData.message;
      if (!message) return;
      void deliverToDiscord(addr, message);
    },
    "turn.started"(_eventData, channel) {
      const addr = decodeToken(channel.continuation.token);
      if (!addr) return;
      void startTyping(addr);
    },
  },
});

function discordAuth(body: InboundBody) {
  return {
    principalId: body.userId,
    principalType: "user" as const,
    authenticator: "discord",
    attributes: {
      guild_id: body.guildId,
      channel_id: body.channelId,
      thread_id: body.threadId ?? "",
      capture_kind: body.files?.length ? "file" : "text",
    },
  };
}

async function deliverToDiscord(addr: { guildId: string; channelId: string; threadId?: string }, text: string) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;
  const channelId = addr.threadId ?? addr.channelId;
  for (const part of splitReply(text)) {
    await rateLimited(
      fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: part, allowed_mentions: { parse: [] } }),
      }),
    );
  }
}

async function startTyping(addr: { guildId: string; channelId: string; threadId?: string }) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;
  const channelId = addr.threadId ?? addr.channelId;
  await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
    method: "POST",
    headers: { authorization: `Bot ${token}` },
  }).catch(() => {});
}

// Minimal 429-aware helper: waits the retry_after header on 429 and returns the response.
async function rateLimited(promise: Promise<Response>): Promise<Response> {
  let res = await promise;
  if (res.status === 429) {
    const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
    const wait = Math.min((data.retry_after ?? 1) * 1000, 30_000);
    await new Promise((r) => setTimeout(r, wait));
    res = await promise;
  }
  return res;
}
```

Note: `channel.continuation.token` is the channel-local address (see `docs/channels/custom`); `POST` accepts a relative path and mounts under the eve server. The `content` array shape is `UserContent` (string parts plus file parts) per the custom-channel contract; if the pinned eve version types differ, follow the exact `UserContent` union from `node_modules/eve/docs/channels/custom.mdx`.

- [ ] **Step 6: Typecheck and unit tests**

```bash
npm run typecheck
npm test
```

Expected: clean; all unit tests PASS. (`agent/channels/discord.ts` is also validated by `eve build`.)

- [ ] **Step 7: Discovery check**

```bash
eve channels list
eve info 2>&1 | tee /tmp/eve-info-routes.txt | grep -i -A2 "discord"
```

Expected: `channels list` shows `discord`; `eve info` lists the custom route. **Record the exact mounted path** (it must end in `.../discord/intake` or be an equivalent prefix you note); Task 6 Step 4 uses it via `EVE_INTAKE_PATH`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add custom Discord intake channel with owner gate"
```

---

### Task 6: Gateway connector (sidecar process)

**Files:**
- Create: `connector/package.json`, `connector/src/index.ts`, `connector/src/gateway.ts`
- Modify: `.env.example` (document `EVE_RUNTIME_URL` default `http://127.0.0.1:3000`)

**Interfaces:**
- Consumes: Task 5 intake route (`POST /eve/v1/discord/intake` + `x-eve-connector-secret`); Task 1 `.env.local`.
- Produces: a long-lived process that streams Discord messages and attachments into the intake route. Exports `DiscordGateway` class with `start()`/`stop()` used by `index.ts`.

Rationale for sidecar: eve channels are route/event adapters; a Discord gateway client is an outbound long-lived connection. Running it as a tiny zero-dependency Node process next to the server (both in docker-compose, Task 7) keeps concerns separate and avoids wedging the gateway lifecycle into module load.

- [ ] **Step 1: Create the connector package**

Create `connector/package.json`:

```json
{
  "name": "ei-connector",
  "private": true,
  "type": "module",
  "engines": { "node": "24.x" },
  "scripts": { "start": "node src/index.ts", "test": "vitest run" }
}
```

Node 24 has a stable global `WebSocket`; no runtime dependencies are needed. Add vitest as a dev dependency with `npm install -D vitest` in `connector/`.

Create `connector/src/gateway.ts` (complete implementation):

```ts
// Zero-dependency Discord gateway client for Node 24 (global WebSocket).
// Covers: identify, HELLO heartbeat, READY/RESUMED, sequence tracking,
// op-close resume, and message intake.

export interface GatewayConfig {
  token: string;
  intents: number;
  ownerId: string;
  onMessage: (msg: InboundMessage) => void;
  log?: (line: string) => void;
}

export interface InboundAttachment {
  name: string;
  mediaType: string;
  url: string;
  size: number;
}

export interface InboundMessage {
  userId: string;
  guildId: string;
  channelId: string;
  threadId?: string;
  text: string;
  attachments: InboundAttachment[];
}

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15,
  DIRECT_MESSAGES: 1 << 12,
};

export class DiscordGateway {
  private ws?: WebSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private heartbeatIntervalMs = 41_250;
  private stopped = false;
  private resumeUrl = GATEWAY_URL;

  constructor(private cfg: GatewayConfig) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close(1000, "shutdown");
  }

  private connect(): void {
    this.cfg.log?.(`connecting to ${this.resumeUrl}`);
    const ws = new WebSocket(this.resumeUrl);
    this.ws = ws;

    ws.onopen = () => {
      const payload = this.sessionId
        ? {
            op: 6,
            d: { token: this.cfg.token, session_id: this.sessionId, seq: this.sequence },
          }
        : {
            op: 2,
            d: {
              token: this.cfg.token,
              intents: this.cfg.intents,
              properties: { os: "linux", browser: "ei-connector", device: "ei-connector" },
            },
          };
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (ev) => {
      const data = JSON.parse(String(ev.data)) as { op: number; s?: number | null; t?: string; d?: any };
      if (typeof data.s === "number") this.sequence = data.s;
      switch (data.op) {
        case 10: // HELLO
          this.heartbeatIntervalMs = data.d.heartbeat_interval as number;
          this.startHeartbeat();
          break;
        case 11: // HEARTBEAT_ACK: no-op
          break;
        case 0: {
          const t = data.t;
          if (t === "READY") {
            this.sessionId = data.d.session_id;
            this.cfg.log?.(`READY as ${data.d.user.username}`);
          } else if (t === "RESUMED") {
            this.cfg.log?.("RESUMED");
          } else if (t === "MESSAGE_CREATE") {
            this.handleMessageCreate(data.d);
          }
          break;
        }
      }
    };

    ws.onclose = (ev) => {
      if (this.stopped) return;
      if (ev.code === 4004 || ev.code === 4010) {
        this.cfg.log?.(`fatal gateway close ${ev.code}, exiting`);
        process.exit(1);
      }
      const backoff = this.sessionId ? 1_000 : 5_000;
      this.cfg.log?.(`gateway closed ${ev.code}; reconnecting in ${backoff}ms`);
      this.stopHeartbeat();
      setTimeout(() => this.connect(), backoff);
    };

    ws.onerror = () => {
      this.cfg.log?.("gateway error");
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.sequence }));
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private handleMessageCreate(d: any): void {
    if (d.author?.bot) return; // never react to itself
    if (String(d.author.id) !== String(this.cfg.ownerId)) return; // owner gate

    const textParts: string[] = [];
    if (typeof d.content === "string") textParts.push(d.content);
    for (const embed of d.embeds ?? []) {
      if (embed.url) textParts.push(`[link] ${embed.url}`);
    }

    const attachments: InboundAttachment[] = (d.attachments ?? [])
      .filter((a: any) => a.size <= 10 * 1024 * 1024)
      .map((a: any) => ({
        name: a.filename as string,
        mediaType: (a.content_type as string) ?? "application/octet-stream",
        url: a.url as string,
        size: a.size as number,
      }));

    this.cfg.onMessage({
      userId: String(d.author.id),
      guildId: d.guild_id ? String(d.guild_id) : "0",
      channelId: String(d.channel_id),
      threadId: d.thread ? String(d.thread.id) : undefined,
      text: textParts.join("\n"),
      attachments,
    });
  }
}
```

- [ ] **Step 2: Write integration tests for normalization (via the class)**

Create `connector/test/gateway.test.ts` (unit-testing `handleMessageCreate` by instantiating with a stub WebSocket is not possible; instead export the pure mapper). Refactor `gateway.ts`: extract a pure function before testing:

```ts
export function mapMessageCreate(d: any, ownerId: string): InboundMessage | null {
  if (d.author?.bot) return null;
  if (String(d.author.id) !== String(ownerId)) return null;
  const attachments: InboundAttachment[] = (d.attachments ?? [])
    .filter((a: any) => a.size <= 10 * 1024 * 1024)
    .map((a: any) => ({
      name: a.filename as string,
      mediaType: (a.content_type as string) ?? "application/octet-stream",
      url: a.url as string,
      size: a.size as number,
    }));
  return {
    userId: String(d.author.id),
    guildId: d.guild_id ? String(d.guild_id) : "0",
    channelId: String(d.channel_id),
    threadId: d.thread ? String(d.thread.id) : undefined,
    text: [d.content, ...(d.embeds ?? []).map((e: any) => (e.url ? `[link] ${e.url}` : "")).filter(Boolean)].join("\n"),
    attachments,
  };
}
```

Update `handleMessageCreate` to call `mapMessageCreate` and skip on null. Add `connector/test/gateway.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapMessageCreate } from "../src/gateway";

describe("mapMessageCreate", () => {
  it("maps a message with attachment", () => {
    const out = mapMessageCreate(
      {
        author: { id: "111", bot: false },
        guild_id: "g1",
        channel_id: "c1",
        content: "hello",
        attachments: [{ filename: "a.pdf", content_type: "application/pdf", url: "https://cdn.discordapp.com/attachments/a", size: 100 }],
      },
      "111",
    );
    expect(out?.text).toBe("hello");
    expect(out?.attachments[0].mediaType).toBe("application/pdf");
  });

  it("drops bots and non-owners", () => {
    expect(mapMessageCreate({ author: { id: "111", bot: true } }, "111")).toBeNull();
    expect(mapMessageCreate({ author: { id: "222" } }, "111")).toBeNull();
  });

  it("filters oversized attachments", () => {
    const out = mapMessageCreate(
      { author: { id: "111", bot: false }, guild_id: "g", channel_id: "c", content: "", attachments: [{ filename: "big.bin", content_type: "application/octet-stream", url: "u", size: 11 * 1024 * 1024 }] },
      "111",
    );
    expect(out?.attachments).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run connector tests, confirm pass**

```bash
cd /root/dev/projects/Ei/connector
npm install
npm test
```

Expected: PASS.

- [ ] **Step 4: Write the process entry point**

Route path: use whatever `eve info` reported as the actual mount for the custom channel in Task 5 Step 7 (the exact prefix under `/eve/` is verified there; `EVE_INTAKE_PATH` defaults to the expected one and the env var is the single override).

Create `connector/src/index.ts`:

```ts
import { DiscordGateway, INTENTS, mapMessageCreate } from "./gateway";

const token = process.env.DISCORD_BOT_TOKEN ?? "";
const ownerId = process.env.AGENT_OWNER_DISCORD_ID ?? "";
const secret = process.env.EVE_CONNECTOR_SECRET ?? "";
const runtimeUrl = process.env.EVE_RUNTIME_URL ?? "http://127.0.0.1:3000";
const intakePath = process.env.EVE_INTAKE_PATH ?? "/eve/v1/discord/intake";

if (!token || !ownerId || !secret) {
  console.error("DISCORD_BOT_TOKEN, AGENT_OWNER_DISCORD_ID, and EVE_CONNECTOR_SECRET are required");
  process.exit(1);
}

const gateway = new DiscordGateway({
  token,
  intents: INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT | INTENTS.DIRECT_MESSAGES,
  ownerId,
  log: (line) => console.log(new Date().toISOString(), line),
  onMessage: async (msg) => {
    try {
      const files = [];
      for (const a of msg.attachments) {
        const res = await fetch(a.url, { headers: { authorization: `Bot ${token}` } });
        if (!res.ok) {
          console.error("attachment download failed", a.name, res.status);
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        files.push({
          name: a.name,
          mediaType: a.mediaType,
          base64: Buffer.from(bytes).toString("base64"),
        });
      }
      const res = await fetch(`${runtimeUrl}${intakePath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eve-connector-secret": secret },
        body: JSON.stringify({
          userId: msg.userId,
          guildId: msg.guildId,
          channelId: msg.channelId,
          threadId: msg.threadId,
          text: msg.text,
          files: files.length ? files : undefined,
        }),
      });
      if (!res.ok && (await res.text()) !== "ignored") {
        console.error("intake failed", res.status, await res.text().catch(() => ""));
      } else {
        console.log("intake ok");
      }
    } catch (err) {
      console.error("intake error", err);
    }
  },
});

gateway.start();
console.log("ei-connector started");

process.on("SIGINT", () => { gateway.stop(); process.exit(0); });
process.on("SIGTERM", () => { gateway.stop(); process.exit(0); });
```

Add `EVE_RUNTIME_URL` and `EVE_INTAKE_PATH` to `.env.example`:

```bash
# connector -> runtime intake (loopback)
EVE_RUNTIME_URL=http://127.0.0.1:3000
# actual mount reported by `eve info` for the custom channel, if different
EVE_INTAKE_PATH=/eve/v1/discord/intake
```

- [ ] **Step 5: Manual end-to-end verification against real Discord**

Prereqs: a Discord application created at discord.com/developers/applications, with a bot user; **Message Content Intent** enabled under Bot settings; invite URL scoped `bot` with permissions `Send Messages`, `Read Message History` (integration type guild install); the bot added to your server (or DMs enabled on the app). Fill `.env.local` with `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `AGENT_OWNER_DISCORD_ID`.

1. Start the runtime: `npm run dev > /tmp/eve-dev.log 2>&1 &` (from the repo root; serves on port 3000).
2. Start the connector: `cd connector && EVE_RUNTIME_URL=http://127.0.0.1:3000 npm start > /tmp/connector.log 2>&1 &`.
3. Watch logs: `tail -f /tmp/connector.log`; expect `READY as <botname>`.
4. In your Discord server (or DM), send: `Remember: the wifi password household is open sesame`.
5. Expect: (a) connector logs `intake ok`; (b) the bot replies via Discord REST with a one-line confirmation; (c) `eve invoke "What is the wifi password household?"` returns the recalled value with citation.
6. Send an image and a PDF attachment; expect capture with confirmation; then query by content.
7. Ask `What is the airspeed velocity of an unladen swallow?`; expect the reply `Not in memory.`
8. From a second Discord account, message the bot; expect silence (owner gate), and no sessions in `.eve/.workflow-data`.
9. Kill the connector mid-session (SIGTERM), restart it; expect `RESUMED` in logs and the next message continuing the same session.

Debug aids: `/tmp/connector.log` and `/tmp/eve-dev.log`; `eve logs` for runtime diagnostics; Discord dev portal audit/interactions logs not needed for gateway.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: add Discord gateway connector (zero-dep)"
```

---

### Task 7: Hardening, deployment packaging, and runbook

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `scripts/eval-ci.sh`, `.github/workflows/evals.yml`, `README.md`
- Modify: `agent/agent.ts` (Postgres workflow world), `.env.example`

**Interfaces:**
- Consumes: Tasks 1-6 artifacts; self-host docs (`node_modules/eve/docs/guides/deployment/self-hosting.md`, committed with the dependency).
- Produces: `docker compose up -d` runs postgres + app + connector on the user's server; `curl http://localhost:PORT/eve/v1/health` answers; runbook documents env, health check, upgrades, and the eval gate.

- [ ] **Step 1: Switch the durable world to Postgres for production**

Pin the Postgres world to the workflow line matching the pinned eve release (`5.0.0-beta` line per self-hosting doc; `@workflow/world-postgres` may lag `latest`):

```bash
version=$(npm view @workflow/world-postgres versions --json | python3 -c 'import json,sys; vs=[v for v in json.load(sys.stdin) if v.startswith("5.0.0-beta")]; print(vs[-1])')
echo "installing @workflow/world-postgres@$version"
npm install "@workflow/world-postgres@$version"
```

Update `agent/agent.ts`:

```ts
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  experimental: {
    workflow: {
      world: "@workflow/world-postgres",
    },
  },
});
```

Read the installed package's README (`node_modules/@workflow/world-postgres/`) for its exact env var names (connection string and pooling), and document them in `.env.example` under a `# postgres world` section (e.g. `POSTGRES_URL=` / `POSTGRES_CONNECTION_STRING=` per that package). Local dev without those env vars still uses the local world.

- [ ] **Step 2: Write the Dockerfile**

Create `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/agent ./agent
COPY --from=build /app/evals ./evals
COPY --from=build /app/docs ./docs
CMD ["node", ".output/server/index.mjs"]
```

(The exact app entry inside `.output` may be `.output/server/index.mjs`: verify by running `eve build` and listing `.output/server/` in a later step; adjust `CMD` if the entry differs.)

- [ ] **Step 3: Write docker-compose.yml**

Create `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ei
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: ei
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ei -d ei"]
      interval: 5s
      timeout: 3s
      retries: 20

  app:
    build: .
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      # model
      AI_GATEWAY_API_KEY: ${AI_GATEWAY_API_KEY:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      # innernet
      INNERNET_KEY: ${INNERNET_KEY:?set INNERNET_KEY}
      # transcription
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      # discord (runtime-side outbound only; connector holds the gateway)
      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:?set DISCORD_BOT_TOKEN}
      AGENT_OWNER_DISCORD_ID: ${AGENT_OWNER_DISCORD_ID:?set AGENT_OWNER_DISCORD_ID}
      EVE_CONNECTOR_SECRET: ${EVE_CONNECTOR_SECRET:?set EVE_CONNECTOR_SECRET}
      # postgres world: match @workflow/world-postgres env names
      POSTGRES_URL: postgres://ei:${POSTGRES_PASSWORD}@db:5432/ei
      # runtime
      PORT: 3000
      HOSTNAME: 0.0.0.0
      # sandbox: Docker backend, running side-by-side
      EVE_SANDBOX: docker
      # no public ports; internal network only
    expose:
      - "3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    # node:24-slim ships no curl; probe with node itself.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/eve/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 10

  connector:
    build:
      context: ./connector
      dockerfile: Dockerfile.connector
    restart: unless-stopped
    depends_on:
      app:
        condition: service_healthy
    environment:
      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:?set DISCORD_BOT_TOKEN}
      AGENT_OWNER_DISCORD_ID: ${AGENT_OWNER_DISCORD_ID:?set AGENT_OWNER_DISCORD_ID}
      EVE_CONNECTOR_SECRET: ${EVE_CONNECTOR_SECRET:?set EVE_CONNECTOR_SECRET}
      EVE_RUNTIME_URL: http://app:3000

volumes:
  pgdata:
```

Create `connector/Dockerfile.connector` (build context is the repo root; paths are relative to it):

```dockerfile
FROM node:24-slim
WORKDIR /conn
COPY connector/package.json connector/package-lock.json ./
RUN npm ci --omit=dev
COPY connector/src ./src
CMD ["node", "src/index.ts"]
```

npm ci requires the lockfile committed in `connector/package-lock.json` (generate it with `npm install` in `connector/`).

- [ ] **Step 4: Write the eval gate script and optional CI**

Create `scripts/eval-ci.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Requires the app to be running (eve eval boots its own local server when none is targeted).
npx eve eval --strict --junit .eve/junit.xml "$@"
```

Create `.github/workflows/evals.yml` (manual dispatch only; evals cost model tokens):

```yaml
name: evals
on:
  workflow_dispatch:
jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npx eve eval --strict --junit .eve/junit.xml
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          INNERNET_KEY: ${{ secrets.INNERNET_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: eval-artifacts
          path: .eve/evals/
```

- [ ] **Step 5: Build, verify self-host layout, health check**

```bash
chmod +x scripts/eval-ci.sh
./docker/root/Dockerfile 2>/dev/null || true   # no-op guard; see note
eve build
ls .output/server/                     # find the server entry (index.mjs typically)
EVE_DEBUG=1 PORT=3000 eve start --host 0.0.0.0 > /tmp/eve-start.log 2>&1 &
sleep 10
curl -fsS http://127.0.0.1:3000/eve/v1/health
curl -fsS -X POST http://127.0.0.1:3000/eve/v1/discord/intake -H "content-type: application/json" -H "x-eve-connector-secret: $EVE_CONNECTOR_SECRET" -d '{"userId":"'$AGENT_OWNER_DISCORD_ID'","guildId":"0","channelId":"c","text":"smoke"}'
```

Expected: health check `200`; intake round-trip responds `ok`; `.output/server/` entry matched in the Dockerfile `CMD`. Kill `eve start`, then align `Dockerfile` CMD if needed.

Now the full stack in containers:

```bash
cp .env.example .env.local        # if not present on the server; fill all required vars
docker compose config             # validates interpolation
docker compose up -d --build
docker compose ps                 # all three services healthy
curl -fsS http://127.0.0.1:3000/eve/v1/health
```

Then repeat the Task 6 manual end-to-end steps against the containerized deployment.

- [ ] **Step 6: Write the runbook**

Create `README.md` with: project summary (memory core slice), the architecture diagram from the spec (Section 3, redrawn as text), the full env table below, quick start (local: `cp .env.example .env.local`, fill keys, `npm run dev`; server: `docker compose up -d --build`), health check, how to run evals (`./scripts/eval-ci.sh`), how to add channels/connections/tools (eve registry note), upgrade path (pin eve + world line, release notes first), and the privacy note (innernet and model APIs are third parties).

Env table for README:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` / `AI_GATEWAY_API_KEY` | one of | Model credential for `anthropic/claude-sonnet-5` |
| `OPENAI_API_KEY` | optional | Whisper transcription |
| `INNERNET_KEY` | yes | innernet MCP memory access |
| `DISCORD_BOT_TOKEN` | yes | Bot token for gateway + REST delivery |
| `DISCORD_APPLICATION_ID` | yes | Application id (invite URL / intents portal) |
| `AGENT_OWNER_DISCORD_ID` | yes | Single owner; everyone else is dropped |
| `EVE_CONNECTOR_SECRET` | yes | Shared secret for the loopback intake route |
| `EVE_RUNTIME_URL` | optional | `http://app:3000` in compose; `http://127.0.0.1:3000` local |
| `POSTGRES_PASSWORD` / world vars | prod | Postgres durable state (hosting) |
| `PORT` | optional | Default 3000 |

- [ ] **Step 7: Final gate and commit**

```bash
npm run typecheck
npm test
./scripts/eval-ci.sh            # all four evals green (--strict)
git check-ignore .env.local
git add -A
git commit -m "chore: containerize, document, and gate the memory agent"
```

Expected: typecheck clean, all unit tests pass, `eve eval --strict` exits 0, `.env.local` ignored, commit succeeds.

---

## Self-Review Notes (run by the plan author)

- **Spec coverage:** channels (custom `defineChannel`, Discord) → Tasks 5-6; connector → Task 6; innernet connection → Task 2; tools (`fetch_page`, `transcribe_audio`) → Task 4; instructions → Task 2; evals (recall, citation, no-fabrication, PDF) → Task 3; durable runtime + Postgres + Docker sandbox → Tasks 1, 7; error handling (10 MB cap, 2000-char split, typing, owner gate, retry on 429, gateway resume) → Tasks 5-6; build order 1-5 → Tasks 1-7; deployment (self-host, no public inbound, systemd/docker-compose, health) → Task 7.
- **Open spec risks addressed:** innernet tool names → Task 2 Step 4 manifest + script gate; connector process model → sidecar chosen (Task 6 header rationale); MESSAGE_CONTENT intent → Task 6 manual prereqs; voice memo → `transcribe_audio` (Task 4); capture noise → conservative instructions (Task 2) with channel/UI filters deferred; cost → eval gate keeps model usage visible, budgets noted in README upgrade section.
- **Placeholder scan:** none; all steps carry code or exact commands. Manifest values (`SAVE_TOOL`, `SEARCH_TOOL`) are discovered in Task 2 and fail a script gate until set, never left as TBD.
- **Type consistency:** `InboundMessage`/`InboundAttachment` used identically in `connector/src/gateway.ts` and `connector/src/index.ts`; `DiscordAddress`/`decodeToken`/`encodeToken`/`splitReply` names match between `agent/channels/discord.ts` and `agent/lib/discord-util.ts`; `fetchPage.execute` / `transcribeAudio.execute` schemas match their tests; `defineEval` `test(t)` usage matches `eve/evals` docs (`t.send`, `t.calledTool`, `t.check`, `t.judge.autoevals.closedQA`).
- **Known to verify during implementation (flagged, not placeholders):** exact `UserContent` part shape and `send` options in the pinned eve version; exact Discord gateway/typing REST endpoints (v10 documented); `@workflow/world-postgres` env var names from its README; `.output/server` entry name; `eve invoke` availability in v0.31.3 (fallback documented).
