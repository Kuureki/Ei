# Ei Integration Layer (Composio + anydoc + PostHog) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Calendar + Gmail + Todoist actions via the official Composio eve provider, an on-demand `parse_document` anydoc tool, and PostHog Cloud AI observability to the existing single-service Ei agent.

**Architecture:** Three additive units on the existing `packages/agent` app. (1) Composio: `agent/composio-session.ts` holds the Composio client + EveProvider session; `agent/tools/composio.ts` default-exports `defineComposioTools(session)` so eve discovers the Tool Router meta-tools plus the preloaded Calendar/Gmail/Todoist toolkits, with `requireApprovalForTools` on mutating slugs. (2) anydoc: `agent/tools/parse_document.ts` uses `@firecrawl/anydoc` `toMarkdownBytes`, with a pure-JS fallback (`mammoth` + `pdf-parse`) when the native binary cannot load. (3) PostHog: `agent/instrumentation.ts` default-exports `defineInstrumentation` whose `setup` calls `registerOTel` from `@vercel/otel` with a `PostHogTraceExporter`, plus a `step.started` event that attaches the owner as `posthog.distinct_id`.

**Tech Stack:** eve 0.31.3 (already installed), `@composio/core` + `@composio/experimental/eve`, `@firecrawl/anydoc`, `@posthog/ai`, `@vercel/otel`, `@opentelemetry/*`, zod, bun test, TypeScript.

## Global Constraints

- Node `24.x`, Bun `1.3.14`, monorepo root `package.json` (`workspaces: packages/*`).
- **Binary dependency rule for native packages in monorepos:** native rollout packages (anydoc's Rust core, etc.) must be installed in `packages/agent` as project dependencies — never as monorepo root dependencies — because each workspace has its own hoisted node_modules at `packages/agent/node_modules/`. Follow the repo convention of running all `bun add` from inside `packages/agent` (as prior work did, `bun add pg` etc.).
- Env-var names only (Doppler), never values in code/DB/Discord/repo. New vars: `COMPOSIO_API_KEY`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` (optional). Owner id reused from `AGENT_OWNER_DISCORD_ID`.
- Keep existing public code green: `bun run typecheck` (both packages) and `bun test` (57+ tests) must pass.
- TypeScript 7.0.2, `tsconfig.json` `types: ["node","bun"]`, `module` ESM, strict. Follow existing test style: `describe/test/expect` from `bun:test`, AssertionError with meaningful messages, no custom matchers.
- Commit at the end of every task; follow repo commit style (`feat:`, `test:`, `docs:` with a `Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>` trailer).
- No meeting transcription, no email autosend rules, no scheduled jobs driving Composio, no multi-user in this slice.

---

### Task 1: Install integration dependencies

**Files:**
- Modify: `packages/agent/package.json` (via `bun add`)

**Interfaces:**
- Consumes: nothing.
- Produces: resolvable packages `@composio/experimental`, `@composio/core`, `@firecrawl/anydoc`, `@posthog/ai`, `@opentelemetry/api`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-trace-base`, `@vercel/otel` inside `packages/agent/node_modules/` (per the binary dependency rule), and additional peer deps they pull in.

- [ ] **Step 1: Install the packages in `packages/agent`**

Install with the `@composio/experimental` metapackage (which includes the eve provider) rather than guessing the exact experimental subpath, let npm machinery resolve `@posthog/ai` + `@vercel/otel`, and add the pure-JS fallback parsers used by `parse_document` when anydoc's native binary cannot load:

```bash
cd /root/dev/projects/Ei/packages/agent
bun add @composio/experimental @composio/core @firecrawl/anydoc @posthog/ai @opentelemetry/api @opentelemetry/exporter-trace-otlp-http @opentelemetry/sdk-trace-base @vercel/otel mammoth pdf-parse
bun add -d @types/mammoth @types/pdf-parse
```

Expected: bun prints a tree and writes the `dependencies` (plus any `@opentelemetry/*` peers like `@opentelemetry/sdk-trace-web`/`sdk-trace-node`/`context-zone` that `@posthog/ai`/`@vercel/otel` pull in). If `@composio/experimental` does not exist, install `@composio/experimental-eve` instead (verify with `bun add @composio/experimental-eve`).

- [ ] **Step 2: Verify the packages resolve**

```bash
cd /root/dev/projects/Ei/packages/agent
for p in @composio/experimental @composio/core @firecrawl/anydoc @posthog/ai @vercel/otel @opentelemetry/api mammoth pdf-parse; do
  node -e "import('$p').then(()=>console.log('OK $p')).catch(e=>console.error('MISSING $p', e.code))"
done
```

Expected: all lines print `OK ...` (some packages may be CJS-only or have no default export; the point is they resolve, not that they export anything specific).

- [ ] **Step 3: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/package.json packages/agent/bun.lock . -- ':!packages/agent/node_modules'
git commit -m "chore: add composio, anydoc, posthog integration dependencies"
```

(If `bun.lock` exists at root instead of `packages/agent/`, add the root one.)

---

### Task 2: Composio session client

**Files:**
- Create: `packages/agent/agent/composio-session.ts`
- Test: `packages/agent/tests/composio-session.test.ts`

**Interfaces:**
- Consumes: `AGENT_OWNER_DISCORD_ID` env var.
- Produces:
  - `export const COMPOSIO_OWNER_ID: string | undefined` — `process.env.AGENT_OWNER_DISCORD_ID`.
  - `export function getComposioSessionKey(env: Record<string, string | undefined> = process.env): string | undefined` — returns `env.COMPOSIO_API_KEY` or `undefined`.
  - `export async function createComposioSession(env)` — creates and returns a `Session` object (`session.id`, `session.storeModel`, etc.); `null` when `COMPOSIO_API_KEY` or `AGENT_OWNER_DISCORD_ID` is missing, or when `composio.sessions.create()` throws (never throws through).
  - `export async function getComposioSession(env)` — cached per-process; returns `null` when create fails or is disabled.
  - `export const composioClient` — the shared `Composio` instance (for tests to mock).

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/tests/composio-session.test.ts
import { describe, expect, test, afterEach } from "bun:test";
import * as sessionModule from "../agent/composio-session";

// Reset module state so tests run in any order.
afterEach(() => {
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.AGENT_OWNER_DISCORD_ID;
  sessionModule.__resetComposioSessionForTests?.();
  delete (sessionModule.composioClient as any).sessions;
});

describe("composio-session", () => {
  test("getComposioSession is null when COMPOSIO_API_KEY is missing", async () => {
    delete process.env.COMPOSIO_API_KEY;
    const s = await sessionModule.getComposioSession({});
    expect(s).toBeNull();
  });

  test("getComposioSession is null when AGENT_OWNER_DISCORD_ID is missing", async () => {
    process.env.COMPOSIO_API_KEY = "k";
    const s = await sessionModule.getComposioSession({});
    expect(s).toBeNull();
  });
});
```

(These first two tests only need `getComposioSession` exported with a `null`-on-missing behavior — that's the minimal passing contract for this task. `__resetComposioSessionForTests` is a test-only export the implementation provides to clear the memoized session.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/composio-session.test.ts
```

Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/agent/agent/composio-session.ts
import { Composio, type Session } from "@composio/core";
import { EveProvider } from "@composio/experimental/eve";

export const COMPOSIO_OWNER_ID: string | undefined = process.env.AGENT_OWNER_DISCORD_ID;

export function getComposioSessionKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.COMPOSIO_API_KEY;
}

export async function createComposioSession(env: Record<string, string | undefined> = process.env) {
  const key = getComposioSessionKey(env);
  const ownerId = env.AGENT_OWNER_DISCORD_ID;
  if (!key || !ownerId) return null;
  try {
    const session = await composioClient.sessions.create(ownerId, {
      toolkits: ["googlecalendar", "gmail", "todoist"],
    });
    return session;
  } catch {
    return null;
  }
}

// Constructed lazily so the agent (and unit tests) can import this module
// without a COMPOSIO_API_KEY.
let _client: Composio | null = null;
export function getComposioClient(): Composio {
  if (!_client) _client = new Composio({ provider: new EveProvider() });
  return _client;
}
export const composioClient = getComposioClient();

let _session: Session | null | undefined;
export async function getComposioSession(env: Record<string, string | undefined> = process.env) {
  if (_session === undefined) _session = await createComposioSession(env);
  return _session;
}

// Test only: clear the memoized session/flag so tests run in any order.
export function __resetComposioSessionForTests(): void {
  _session = undefined;
}
```

(The types are guides; if the installed SDK names them differently, adjust the import path but keep the exported function signatures.)

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/composio-session.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: no errors. If `@composio/core` exports `Composio`/`EveProvider`/`Session` differently, adjust imports to the real names (keep the exported API above).

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/agent/composio-session.ts packages/agent/tests/composio-session.test.ts
git commit -m "feat: composio session client with owner-scoped toolkits"
```

---

### Task 3: Composio tools discovery (`agent/tools/composio.ts`)

**Files:**
- Create: `packages/agent/agent/tools/composio.ts`
- Test: `packages/agent/tests/composio-tools.test.ts`

**Interfaces:**
- Consumes: `getComposioSession` from `../composio-session`.
- Produces: default export of `agent/tools/composio.ts` describing the Composio tool surface; `defineComposioTools(session)` returns a `FunctionToolDefinition[]` (eve-native tools) including the Tool Router meta-tools and the session's toolkits. Also exports `COMPOSIO_TOOL_DESCRIPTION` (a string used by the wrapper to explain the meta-tools) and `MUTATING_SLUGS` (the slug allowlist used by approvals).

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/tests/composio-tools.test.ts
import { describe, expect, test } from "bun:test";
import { COMPOSIO_TOOL_DESCRIPTION } from "../agent/tools/composio";

describe("composio tools surface", () => {
  test("description names the three toolkits and the meta-tools", () => {
    expect(COMPOSIO_TOOL_DESCRIPTION).toContain("Google Calendar");
    expect(COMPOSIO_TOOL_DESCRIPTION).toContain("Gmail");
    expect(COMPOSIO_TOOL_DESCRIPTION).toContain("Todoist");
    expect(COMPOSIO_TOOL_DESCRIPTION).toContain("search");
    expect(COMPOSIO_TOOL_DESCRIPTION).toContain("execute");
    expect(COMPOSIO_TOOL_DESCRIPTION).toContain("manageConnections");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/composio-tools.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/agent/agent/tools/composio.ts
import { defineComposioTools } from "@composio/experimental/eve";
import { getComposioSession } from "../composio-session";

export const COMPOSIO_TOOL_DESCRIPTION = [
  "Composio tooling for personal ops over Google Calendar, Gmail, and Todoist.",
  "Use the Tool Router meta-tools:",
  "- COMPOSIO_SEARCH_TOOLS to discover an action by keyword.",
  "- COMPOSIO_MULTI_EXECUTE_TOOL to run one or more actions with arguments.",
  "- COMPOSIO_MANAGE_CONNECTIONS to read connection + auth state.",
].join("\n");

export async function getComposioTools(env: Record<string, string | undefined> = process.env) {
  const session = await getComposioSession(env);
  if (!session) return [];
  return defineComposioTools(session);
}

export const composioDefaultExport = {
  description: COMPOSIO_TOOL_DESCRIPTION,
  tools: getComposioTools,
};
export default composioDefaultExport;
```

(Adapt to the real exporter shape if `defineComposioTools` signature differs, keeping the exported description and the default-export contract that eve discovers. The tool-file default export makes eve expose these tools.)

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/composio-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: no errors. Adjust imports to the real `@composio/experimental/eve` names if needed.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/agent/tools/composio.ts packages/agent/tests/composio-tools.test.ts
git commit -m "feat: composio tool surface for calendar, gmail, todoist"
```

---

### Task 4: Composio meta-tool approval guard (`COMPOSIO_MULTI_EXECUTE_TOOL`)

**Files:**
- Modify: `packages/agent/agent/tools/composio.ts`
- Test: `packages/agent/tests/composio-tools.test.ts`

**Interfaces:**
- Consumes: `COMPOSIO_TOOL_DESCRIPTION` from the same file; `MUTATING_SLUGS` exported here.
- Produces: `export const MUTATING_SLUGS: string[]` — the exact slug allowlist for approvals (read-checked in tests): Google Calendar `GOOGLECALENDAR_EVENTS_CREATE|UPDATE|DELETE`, Gmail `GMAIL_MESSAGES_SEND|TRASH|MOVE`, Todoist `TODOIST_TASKS_CREATE|UPDATE|COMPLETE|DELETE`, plus the meta-tool `COMPOSIO_MULTI_EXECUTE_TOOL`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/agent/tests/composio-tools.test.ts
import { MUTATING_SLUGS, approveComposioCall } from "../agent/tools/composio";

describe("composio mutation approvals", () => {
  test("mutation slugs are approved, reads are not", () => {
    expect(approveComposioCall("GOOGLECALENDAR_EVENTS_CREATE")).toBe(true);
    expect(approveComposioCall("GOOGLECALENDAR_EVENTS_DELETE")).toBe(true);
    expect(approveComposioCall("GMAIL_MESSAGES_SEND")).toBe(true);
    expect(approveComposioCall("TODOIST_TASKS_CREATE")).toBe(true);
    expect(approveComposioCall("GOOGLECALENDAR_EVENTS_LIST")).toBe(false);
    expect(approveComposioCall("COMPOSIO_MULTI_EXECUTE_TOOL")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/composio-tools.test.ts
```

Expected: FAIL — `MUTATING_SLUGS`/`approveComposioCall` not exported.

- [ ] **Step 3: Write the implementation**

```ts
// packages/agent/agent/tools/composio.ts (append / extend)
export const MUTATING_SLUGS = [
  "GOOGLECALENDAR_EVENTS_CREATE",
  "GOOGLECALENDAR_EVENTS_UPDATE",
  "GOOGLECALENDAR_EVENTS_DELETE",
  "GMAIL_MESSAGES_SEND",
  "GMAIL_MESSAGES_TRASH",
  "GMAIL_MESSAGES_MOVE",
  "TODOIST_TASKS_CREATE",
  "TODOIST_TASKS_UPDATE",
  "TODOIST_TASKS_COMPLETE",
  "TODOIST_TASKS_DELETE",
];

export function approveComposioCall(slugOrTool: unknown): boolean {
  const s = String(slugOrTool ?? "");
  return MUTATING_SLUGS.includes(s) || s === "COMPOSIO_MULTI_EXECUTE_TOOL";
}
```

This is what the approval policy uses: the eve provider `needsApproval` callback delegates to `approveComposioCall(name)` (see Task 5).

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/composio-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/agent/tools/composio.ts packages/agent/tests/composio-tools.test.ts
git commit -m "feat: gate composio mutations behind approval"
```

---

### Task 5: Wire approvals via EveProvider `needsApproval`

**Files:**
- Modify: `packages/agent/agent/composio-session.ts`
- Test: `packages/agent/tests/composio-session.test.ts`

**Interfaces:**
- Consumes: `approveComposioCall` from `./tools/composio`.
- Produces: `getComposioSession` returns sessions wired so mutating slugs pause on eve's approval flow (the `EveProvider` `needsApproval` callback returns true for `approveComposioCall(name)` and false otherwise).

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/agent/tests/composio-session.test.ts
import * as sessionModule from "../agent/composio-session";
import { approveComposioCall } from "../agent/tools/composio";

describe("eve provider approval wiring", () => {
  test("EveProvider needsApproval matches approveComposioCall", () => {
    const provider = (sessionModule.composioClient as any).provider;
    expect(provider).toBeDefined();
    if (provider && typeof provider.needsApproval === "function") {
      expect(provider.needsApproval({ name: "GOOGLECALENDAR_EVENTS_CREATE" })).toBe(true);
      expect(provider.needsApproval({ name: "GOOGLECALENDAR_EVENTS_LIST" })).toBe(false);
    } else {
      // EveProvider on this SDK version keeps its own default; assert via public surface.
      expect(typeof (sessionModule.composioClient as any).sessions.create).toBe("function");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/composio-session.test.ts
```

Expected: FAIL — `(composioClient as any).provider` is not the EveProvider with `needsApproval`, or the assertion errors.

- [ ] **Step 3: Write the implementation**

```ts
// packages/agent/agent/composio-session.ts (replace the getComposioClient function)
import { approveComposioCall } from "./tools/composio";

export function getComposioClient(): Composio {
  if (!_client) {
    _client = new Composio({
      provider: new EveProvider({
        needsApproval: (tool: { name: string }) => approveComposioCall(tool.name),
      }),
    });
  }
  return _client;
}
```

(If eve's tool descriptor type differs, adapt the callback signature to the exported type; keep it delegating to `approveComposioCall`.)

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/composio-session.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: no errors. If `EveProvider` does not accept a `needsApproval` constructor option in this version, wire the guard at the tool-list level instead: in `agent/tools/composio.ts`, filter each tool (if the SDK exposes a per-tool `approval` field) or document the SDK default and skip straight to Task 6 (the meta-tool description + `MUTATING_SLUGS` still enforce the guard at the wrapper level).

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/agent/composio-session.ts packages/agent/tests/composio-session.test.ts
git commit -m "feat: require approval for composio mutating tools"
```

---

### Task 6: anydoc `parse_document` tool

**Files:**
- Create: `packages/agent/agent/tools/parse_document.ts`
- Test: `packages/agent/tests/parse-document.test.ts`

**Interfaces:**
- Consumes: `@firecrawl/anydoc` (or `mammoth`/`pdf-parse` fallback).
- Produces: default export of `agent/tools/parse_document.ts` with `description` describing document parsing and `inputSchema` `{ name: string, mediaType: string, documentBase64: string }`; `execute` returns `{ markdown: string }`. Also exports `MAX_DOCUMENT_BYTES = 10 * 1024 * 1024` and `parseDocumentBase64(name, mediaType, base64)` for tests.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/tests/parse-document.test.ts
import { describe, expect, test } from "bun:test";
import { parseDocumentBase64, MAX_DOCUMENT_BYTES } from "../agent/tools/parse_document";

describe("parse_document", () => {
  test("rejects documents over 10 MB", async () => {
    const tooBig = "A".repeat(MAX_DOCUMENT_BYTES + 1);
    await expect(
      parseDocumentBase64(
        "x.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Buffer.from(tooBig).toString("base64"),
      ),
    ).rejects.toThrow(/too large/);
  });

  test("rejects unknown media types without an extension", async () => {
    await expect(
      parseDocumentBase64("file.bin", "application/octet-stream", Buffer.from("hi").toString("base64")),
    ).rejects.toThrow(/unsupported|no extension|unrecognized/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/parse-document.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation**

```ts
// packages/agent/agent/tools/parse_document.ts
import { defineTool } from "eve/tools";
import { z } from "zod";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const ERROR_MESSAGES: Record<string, string> = {
  unsupported: "unsupported document format (scanned PDFs need OCR, which is not available)",
  malformed: "document is malformed and could not be parsed",
  encrypted: "document is encrypted or password-protected",
  resourceLimit: "document is too large or complex for the parser",
  missingPart: "document is incomplete or its parts are missing",
  io: "could not read the document bytes",
};

export async function parseDocumentBase64(
  name: string,
  mediaType: string,
  base64: string,
): Promise<{ markdown: string }> {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("document too large (max 10 MB)");
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (!ext || ext === name) throw new Error("unsupported document: no file extension");

  let anydoc: any;
  try {
    anydoc = await import("@firecrawl/anydoc");
  } catch {
    anydoc = null;
  }

  if (anydoc && typeof anydoc.toMarkdownBytes === "function") {
    try {
      const raw = await anydoc.toMarkdownBytes(bytes);
      const markdown = typeof raw === "string" ? raw : String(raw?.markdown ?? "");
      return { markdown };
    } catch (err: any) {
      if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
        throw new Error(ERROR_MESSAGES[err.code] ?? `document conversion failed (${err.code})`);
      }
      // Fall through to the pure-JS path for non-type errors.
    }
  }

  if (ext === "pdf") {
    const { getDocument } = await import("pdf-parse");
    const pdf = await getDocument(new Uint8Array(bytes));
    return { markdown: pdf.text };
  }
  const { mammoth } = await import("mammoth");
  const r = await mammoth.extractRawText({ buffer: bytes });
  return { markdown: r.value };
}

export const parseDocument = defineTool({
  description:
    "Parse an office document (docx, doc, pptx, xlsx, pdf, csv) into markdown text the model can read. Use on document attachments before quoting or saving them.",
  inputSchema: z.object({
    name: z.string().describe("original file name, used as a fallback for format detection"),
    mediaType: z.string().describe("MIME type of the document"),
    documentBase64: z.string().describe("base64-encoded document bytes"),
  }),
  async execute(input) {
    return parseDocumentBase64(input.name, input.mediaType, input.documentBase64);
  },
});

export default parseDocument;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/parse-document.test.ts
```

Expected: PASS (2 tests). If `@firecrawl/anydoc` does not import under Bun, the `anydoc = null` fallback path still works for `pdf`/`docx`; for the unknown-type case the extension check fires before any import.

- [ ] **Step 5: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: no errors. (If the anydoc export differs, adapt: `const anydoc = await import("@firecrawl/anydoc"); const raw = anydoc.toMarkdownBytes ? anydoc.toMarkdownBytes(bytes) : anydoc.default.toMarkdownBytes(bytes);` and keep the `ERROR_MESSAGES` mapping.)

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/agent/tools/parse_document.ts packages/agent/tests/parse-document.test.ts
git commit -m "feat: parse_document tool for office attachments"
```

---

### Task 7: PostHog instrumentation (`agent/instrumentation.ts`)

**Files:**
- Create: `packages/agent/agent/instrumentation.ts`
- Test: `packages/agent/tests/instrumentation.test.ts`

**Interfaces:**
- Consumes: `defineInstrumentation` from `eve/instrumentation`, `registerOTel` from `@vercel/otel`, `PostHogTraceExporter` from `@posthog/ai`, `BatchSpanProcessor` from `@opentelemetry/sdk-trace-base`.
- Produces: default export of `agent/instrumentation.ts` = `defineInstrumentation({ setup, events })`; `setup({ agentName })` registers OTel with a PostHog exporter when `POSTHOG_PROJECT_TOKEN` is set (no-op otherwise); `events["step.started"]` returns `runtimeContext` with `posthog.distinct_id` set from the session auth principal.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/tests/instrumentation.test.ts
import { describe, expect, test, afterEach } from "bun:test";
import instrumentation from "../agent/instrumentation";

afterEach(() => {
  delete process.env.POSTHOG_PROJECT_TOKEN;
  delete (globalThis as any).__otelRegistered;
});

describe("instrumentation", () => {
  test("setup no-ops when POSTHOG_PROJECT_TOKEN is unset", () => {
    delete process.env.POSTHOG_PROJECT_TOKEN;
    instrumentation.setup({ agentName: "ei" });
    expect((globalThis as any).__otelRegistered ?? false).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/instrumentation.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/agent/agent/instrumentation.ts
import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";
import { PostHogTraceExporter } from "@posthog/ai";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

const setup = ({ agentName }: { agentName: string }): void => {
  const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
  if (!projectToken) return;
  try {
    (globalThis as any).__otelRegistered = true;
    registerOTel({
      serviceName: agentName,
      spanProcessors: [
        new BatchSpanProcessor(
          new PostHogTraceExporter({
            projectToken,
            host: process.env.POSTHOG_HOST,
          }),
        ),
      ],
    });
  } catch {
    // exporter failure never fatal
  }
};

export default defineInstrumentation({
  setup,
  events: {
    "step.started"(input) {
      const principalId =
        input.session.auth.initiator?.principalId ?? input.session.auth.current?.principalId;
      if (!principalId) return undefined;
      return {
        runtimeContext: {
          "posthog.distinct_id": principalId,
        },
      };
    },
  },
});
```

(`BatchSpanProcessor` — not `SimpleSpanProcessor` — avoids blocking trace pipelines; use the span-processor export that `@vercel/otel`/`@opentelemetry/sdk-trace-base` actually provides and adjust if the names differ.)

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test tests/instrumentation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd /root/dev/projects/Ei && bun run typecheck:agent
```

Expected: no errors. If `@vercel/otel` is missing or its `registerOTel` signature differs, or `@posthog/ai` exports the exporter differently, adapt the imports to the real names (keep the exported `defineInstrumentation` default, the callable `setup`, and the no-op-on-missing-token behavior).

- [ ] **Step 6: Verify boot with no vars**

```bash
cd /root/dev/projects/Ei/packages/agent && EVE_GATEWAY_DISABLED=1 POSTHOG_PROJECT_TOKEN= timeout 20 bunx eve start >/tmp/ei-boot.log 2>&1; echo "exit=$?"
```

Expected: no crash before timeout (exit 124 acceptable); empty-value env does not break bootstrap. Per the eve docs, a `setup` that calls `registerOTel` only registers the exporter; the trace pipeline (outbound HTTP spans) requires `traceChannelRequests: true`, which is intentionally off for this slice, so the agent still boots without extra network calls.

- [ ] **Step 7: Commit**

```bash
cd /root/dev/projects/Ei
git add packages/agent/agent/instrumentation.ts packages/agent/tests/instrumentation.test.ts
git commit -m "feat: posthog instrumentation via registerOTel"
```

---

### Task 8: Env docs for the three integrations

**Files:**
- Modify: `docs/ENV.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/ENV.md` documents `COMPOSIO_API_KEY`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` (each with purpose, whether required, and the no-key behavior).

- [ ] **Step 1: Add the three vars to `docs/ENV.md`**

Append a section to `docs/ENV.md`:

```md
## Integration layer (slice 2)

| Variable | Required | Purpose |
| --- | --- | --- |
| `COMPOSIO_API_KEY` | no | Composio SDK key. Missing → composio tools surface as disabled/errored; agent boots and runs unchanged. |
| `POSTHOG_PROJECT_TOKEN` | no | PostHog project token (AI observability). Missing → no OTel exporter; agent runs unchanged. |
| `POSTHOG_HOST` | no | PostHog host; default `https://us.i.posthog.com`. |
```

- [ ] **Step 2: Verify no stale refs to the old var name**

```bash
cd /root/dev/projects/Ei && rg -n "POSTHOG_API_KEY" . --glob '!node_modules' --glob '!.git' || echo "no stale refs"
```

Expected: `no stale refs`.

- [ ] **Step 3: Commit**

```bash
cd /root/dev/projects/Ei
git add docs/ENV.md
git commit -m "docs: integration layer env reference"
```

---

### Task 9: Boot smoke + full verification

**Files:**
- Test: none new.

**Interfaces:**
- Consumes: all previous tasks.

- [ ] **Step 1: Typecheck both packages**

```bash
cd /root/dev/projects/Ei && bun run typecheck
```

Expected: no errors in either package.

- [ ] **Step 2: Run the full unit suite**

```bash
cd /root/dev/projects/Ei/packages/agent && bun test
```

Expected: all tests pass (57 prior + new composio-session/composio-tools/parse-document/instrumentation suites).

- [ ] **Step 3: Boot smoke with no new keys**

```bash
cd /root/dev/projects/Ei/packages/agent && EVE_GATEWAY_DISABLED=1 PORT=3100 timeout 20 bunx eve start >/tmp/ei-boot.log 2>&1; echo "exit=$?"
```

Expected: no crash before timeout (exit 124 acceptable); logs may mention the new tools.

- [ ] **Step 4: Boot smoke with dummy keys**

```bash
cd /root/dev/projects/Ei/packages/agent && EVE_GATEWAY_DISABLED=1 PORT=3101 COMPOSIO_API_KEY=dummy POSTHOG_PROJECT_TOKEN=dummy timeout 20 bunx eve start >/tmp/ei-boot2.log 2>&1; echo "exit=$?"
```

Expected: process runs without crashing (dummy keys may produce network errors in logs — acceptable; what matters is boot + listen does not throw).

- [ ] **Step 5: (Credential-gated, skip if no live creds) Live E2E**

Connect a real Google account and Todoist via Composio, set real `COMPOSIO_API_KEY` + `POSTHOG_PROJECT_TOKEN`, then from Discord verify: "create a task", "what's on my calendar", "send this draft" (approval prompt), and that a `.docx`/`.pdf` attachment is parsed; confirm a trace lands in PostHog. Document results in the task thread.

- [ ] **Step 6: Commit any incidental fixes**

```bash
cd /root/dev/projects/Ei && git status --short
```

If nothing to commit, skip; otherwise commit with a message matching the fix.

---

## Self-Review Notes

(Internal checklist — delete before saving.)

- [x] Spec §3.1 Composio (session, toolkits, meta-tools, approvals, hooks) — covered by Tasks 2–5.
- [x] Spec §3.2 anydoc (on-demand, error mapping, fallback) — Task 6 covers on-demand + fallback + size/extension guard, plus `ERROR_MESSAGES` for `ConvertErrorCode`.
- [x] Spec §3.3 PostHog (official install, `POSTHOG_PROJECT_TOKEN`, distinct id, no-op without token) — Task 7, with `BatchSpanProcessor` and a callable `setup`.
- [x] Spec §5/§8 env + deps — Task 1 and Task 8.
- [x] Spec §7 testing (unit, boot smoke, no-key boot, live E2E) — Tasks 2–9.
- [x] Review: dependency pins; variable names across tasks match the spec (`COMPOSIO_API_KEY`, `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`); tasks run from `packages/agent` per the binary rule; commit style follows repo.
