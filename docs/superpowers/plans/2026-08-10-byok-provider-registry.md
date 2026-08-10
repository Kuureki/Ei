# BYOK Provider Registry + Ops Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved BYOK provider-ops slice: a Postgres-backed provider registry with native Discord slash commands, Hermes-style model discovery (`/v1/models` + models.dev), live `step.started` model resolution with gateway fallback, and the Discord gateway running in-process with the eve agent as one deployable service under strict Doppler envs.

**Architecture:** The eve agent owns everything. A second custom channel (`POST /interact`) receives interaction events from the in-process Discord gateway (moved from `packages/connector`, now `packages/agent/lib/gateway/`) and services them via interaction REST (deferred ACK + followup, autocomplete, one modal). A `defineDynamic` model resolver at `step.started` returns a live `@ai-sdk/openai` LanguageModel built from the active provider row (key resolved from a Doppler env *name*); any failure returns `null` and eve falls back to the gateway model. Registry + models cache + config live in `ei_*` tables in the same Postgres as the workflow world.

**Tech Stack:** eve 0.31.3 (Node 24 runtime), Bun 1.3.14 tooling, `@ai-sdk/openai@4.0.17` (matches eve's bundled version), `ai`, `pg` + `pg-mem` (tests), Discord API v10, models.dev `api.json`.

## Global Constraints

- Repo root: `/root/dev/projects/Ei`. Run commands from this root unless a step says otherwise.
- Runtime: Node 24 (eve runs under Bun's shebang) — the gateway code must stay pure global `WebSocket`/`fetch` (no `Bun.*`, no `node:*` server APIs).
- TypeScript: `strict`, ES2022, `moduleResolution: bundler`, `noEmit`. Typecheck gate: `cd /root/dev/projects/Ei/packages/agent && bunx tsc -p tsconfig.json`.
- Import specifiers: relative imports are extensionless (`../lib/db`), matching the existing connector style.
- Code style: double quotes, semicolons, 2-space indent, trailing commas, named type exports.
- Secret policy (strict Doppler): never write a secret value to code, Postgres, Discord, or docs. Provider rows store only the env-var *name* (`key_env`). `.env.example` files exist today and are deleted in Task 12; nothing in this plan creates env files.
- eve channel contract: custom channels mount bare routes via `defineChannel({ routes: [POST(path, handler)] })` — route paths have **no** `/eve/v1` prefix. Route handlers must return a `Response`.
- eve dynamic model contract: `fallback` anchors build metadata; `step.started` may return a live AI SDK `LanguageModel`; session/turn selections must be string ids (not used here); resolver failures must degrade to `null`, never throw through.
- DB availability is optional: the agent must boot and answer with the fallback model when `WORKFLOW_POSTGRES_URL` is unset or unreachable. All DB touches degrade to `null`/empty and never crash the turn.
- models.dev `api.json` shape (verified 2026-08-10): top-level map `providerId -> { id, env, npm, api?, name, models }`; model entry: `{ id, name?, reasoning?, tool_call?, structured_output?, limit: { context?, output? }, cost: { input?, output? } }`.
- Postgres/JSON nuance: pg returns `jsonb` as a parsed object, pg-mem may return it as a string. Use the `jsonValue(v)` helper everywhere a `jsonb` cell is read.
- Interaction constants: ephemeral flag `1 << 6`; callback `https://discord.com/api/v10/interactions/{id}/{token}/callback`; followup `https://discord.com/api/v10/webhooks/{app_id}/{token}/messages/@original`.
- `/provider add` responds with a modal (`type: 9`); all other commands use deferred ACK (`type: 5`, ephemeral) then a follow-up PATCH. Autocomplete is `type: 8` answered from the cache only.
- Repo conventions: read `packages/agent/AGENTS.md` at the start of Task 1 and obey anything in it.

---

### Task 1: Move the gateway into the agent package and delete the connector

**Files:**
- Create: `packages/agent/lib/gateway/gateway.ts` (move of `packages/connector/src/gateway.ts`, plus the interaction type from Step 3)
- Create: `packages/agent/lib/gateway/index.ts` (boot + forwarders, adapted from `packages/connector/src/index.ts`)
- Delete: `packages/connector/` (entire directory; its content is copied out first)
- Modify: `package.json` (root): remove the `"dev:connector"` script
- Modify: `packages/agent/tsconfig.json`: `include: ["agent/**/*.ts", "evals/**/*.ts", "lib/**/*.ts", "tests/**/*.ts"]`

**Interfaces:**
- Consumes: nothing new.
- Produces: `lib/gateway/index.ts` exports `startGateway(boot?: { env?; fetchImpl? }): Promise<void>`, `shouldStartGateway(env): boolean`, `runtimeIntakeUrl(env): { intake; interact }`, `forwardMessage(msg, deps)`, `forwardInteraction(ev, deps)`. `lib/gateway/gateway.ts` exports `DiscordGateway`, `INTENTS`, `mapMessageCreate`, `mapInteractionCreate`, `InboundMessage`, `InteractionEvent`.

- [ ] **Step 1: Read the repo conventions**

Read `packages/agent/AGENTS.md` and the two root-level files it points at (if any). Obey any conventions. Note: this project's private rules take precedence over the plan's Global Constraints where they conflict.

- [ ] **Step 2: Copy the gateway core**

Copy `packages/connector/src/gateway.ts` to `packages/agent/lib/gateway/gateway.ts` with no content changes yet.

- [ ] **Step 3: Extend `gateway.ts` with the interaction type and callback**

In `packages/agent/lib/gateway/gateway.ts` add (after the `InboundMessage` interface):

```ts
export type InteractionKind = 2 | 4 | 5; // APPLICATION_COMMAND, AUTOCOMPLETE, MODAL_SUBMIT

export interface InteractionEvent {
  id: string;
  type: InteractionKind;
  token: string;
  userId: string;
  guildId?: string;
  channelId: string;
  data: {
    name?: string;
    custom_id?: string;
    options?: unknown[];
    components?: unknown;
    resolved?: unknown;
  };
}
```

and in `GatewayConfig` add:

```ts
  onInteraction?: (interaction: InteractionEvent) => void;
```

- [ ] **Step 4: Write the boot module**

Create `packages/agent/lib/gateway/index.ts`:

```ts
// In-process Discord gateway: socket client + loopback forwarding.
// Pure global WebSocket/fetch — must stay runtime-agnostic (Node 24).
import { DiscordGateway, INTENTS, type InboundMessage, type InteractionEvent } from "./gateway";

export interface GatewayBootConfig {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function shouldStartGateway(env: NodeJS.ProcessEnv): boolean {
  const v = env.EVE_GATEWAY_DISABLED;
  return v !== "1" && v !== "true";
}

export function runtimeIntakeUrl(env: NodeJS.ProcessEnv): { intake: string; interact: string } {
  const port = Number(env.PORT ?? 3000);
  const base = env.EVE_RUNTIME_URL ?? `http://127.0.0.1:${port}`;
  return {
    intake: `${base}${env.EVE_INTAKE_PATH ?? "/intake"}`,
    interact: `${base}/interact`,
  };
}

export async function forwardMessage(
  msg: InboundMessage,
  deps: { token: string; secret: string; intakeUrl: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const files: Array<{ name: string; mediaType: string; base64: string }> = [];
  for (const a of msg.attachments) {
    const res = await f(a.url, { headers: { authorization: `Bot ${deps.token}` } });
    if (!res.ok) {
      console.error("attachment download failed", a.name, res.status);
      continue;
    }
    files.push({
      name: a.name,
      mediaType: a.mediaType,
      base64: Buffer.from(await res.arrayBuffer()).toString("base64"),
    });
  }
  const res = await f(deps.intakeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eve-connector-secret": deps.secret },
    body: JSON.stringify({
      userId: msg.userId,
      guildId: msg.guildId,
      channelId: msg.channelId,
      threadId: msg.threadId,
      text: msg.text,
      files: files.length ? files : undefined,
    }),
  });
  const bodyText = await res.text().catch(() => "");
  if (!res.ok && bodyText !== "ignored") console.error("intake failed", res.status, bodyText);
  else console.log("intake ok");
}

export async function forwardInteraction(
  ev: InteractionEvent,
  deps: { secret: string; interactUrl: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(deps.interactUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-eve-connector-secret": deps.secret },
      body: JSON.stringify({ interaction: ev }),
    });
    if (!res.ok) console.error("interact failed", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("interact error", err);
  }
}

export async function startGateway(boot: GatewayBootConfig = {}): Promise<void> {
  const env = boot.env ?? process.env;
  const f = boot.fetchImpl ?? fetch;
  const token = env.DISCORD_BOT_TOKEN ?? "";
  const ownerId = env.AGENT_OWNER_DISCORD_ID ?? "";
  const secret = env.EVE_CONNECTOR_SECRET ?? "";
  if (!token || !ownerId || !secret) {
    console.error("gateway disabled: DISCORD_BOT_TOKEN, AGENT_OWNER_DISCORD_ID, EVE_CONNECTOR_SECRET required");
    return;
  }
  const { intake, interact } = runtimeIntakeUrl(env);
  const gateway = new DiscordGateway({
    token,
    intents:
      INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT | INTENTS.DIRECT_MESSAGES,
    ownerId,
    gatewayUrl: env.EVE_GATEWAY_URL, // local testing only
    log: (line) => console.log(new Date().toISOString(), line),
    onMessage: (msg) => {
      void forwardMessage(msg, { token, secret, intakeUrl: intake, fetchImpl: f }).catch(() => {});
    },
    onInteraction: (ev) => {
      void forwardInteraction(ev, { secret, interactUrl: interact, fetchImpl: f }).catch(() => {});
    },
  });
  gateway.start();
  console.log("ei gateway started");
  const stop = () => {
    gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
```

- [ ] **Step 5: Delete the connector package and repoint the workspace**

```bash
rm -rf /root/dev/projects/Ei/packages/connector
```

In root `package.json`, delete the `"dev:connector"` line from `scripts`.

- [ ] **Step 6: Verify**

```bash
cd /root/dev/projects/Ei && bun install
cd packages/agent && bunx tsc -p tsconfig.json
```
Expected: install relocks without the connector package; typecheck clean (tests for Task 2 arrive in the next task).

- [ ] **Step 7: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "refactor: move discord gateway into agent package as lib/gateway"
```

---

### Task 2: Gateway interaction parsing and forwarding

**Files:**
- Modify: `packages/agent/lib/gateway/gateway.ts` (add `mapInteractionCreate`, wire `INTERACTION_CREATE` dispatch)
- Test: `packages/agent/tests/gateway.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 `InteractionEvent` type, `forwardInteraction` helper.
- Produces: `mapInteractionCreate(d: unknown, ownerId: string): InteractionEvent | null` — used by Task 7's admin flow.

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/tests/gateway.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mapInteractionCreate, mapMessageCreate } from "../lib/gateway/gateway";
import { forwardInteraction, forwardMessage, runtimeIntakeUrl } from "../lib/gateway/index";

const OWNER = "123";

describe("mapMessageCreate", () => {
  test("drops bots and non-owners", () => {
    expect(mapMessageCreate({ author: { id: OWNER, bot: true } }, OWNER)).toBeNull();
    expect(mapMessageCreate({ author: { id: "999" } }, OWNER)).toBeNull();
  });
  test("keeps owner messages and maps embeds to text", () => {
    const m = mapMessageCreate(
      {
        id: "m1",
        author: { id: OWNER, bot: false },
        channel_id: "c1",
        guild_id: "g1",
        content: "hello",
        embeds: [{ url: "https://example.com" }, { url: undefined }],
        attachments: [],
      },
      OWNER,
    );
    expect(m).not.toBeNull();
    expect(m!.text).toBe("hello\n[link] https://example.com");
    expect(m!.channelId).toBe("c1");
  });
});

describe("mapInteractionCreate", () => {
  test.each([2, 4, 5] as const)("keeps owner interaction type %i", (type) => {
    const ev = mapInteractionCreate(
      { id: "i1", type, token: "tok", channel_id: "c1", member: { user: { id: OWNER } }, data: { name: "x" } },
      OWNER,
    );
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe(type);
  });
  test("drops non-owner and unknown types", () => {
    expect(mapInteractionCreate({ id: "i2", type: 2, token: "t", member: { user: { id: "999" } } }, OWNER)).toBeNull();
    expect(mapInteractionCreate({ id: "i3", type: 0, token: "t", member: { user: { id: OWNER } } }, OWNER)).toBeNull();
  });
  test("reads user fallback, guild id, and modal custom_id", () => {
    const ev = mapInteractionCreate(
      { id: "i4", type: 5, token: "t", channel_id: "c1", guild_id: "g1", user: { id: OWNER }, data: { custom_id: "provider_add" } },
      OWNER,
    );
    expect(ev!.guildId).toBe("g1");
    expect(ev!.data.custom_id).toBe("provider_add");
  });
});

describe("forwarders", () => {
  test("runtimeIntakeUrl defaults to loopback", () => {
    expect(runtimeIntakeUrl({})).toEqual({
      intake: "http://127.0.0.1:3000/intake",
      interact: "http://127.0.0.1:3000/interact",
    });
    expect(runtimeIntakeUrl({ EVE_RUNTIME_URL: "http://host:9" })).toEqual({
      intake: "http://host:9/intake",
      interact: "http://host:9/interact",
    });
  });

  test("forwardMessage posts the normalized body with the secret header", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) });
      return new Response("ok");
    }) as typeof fetch;
    await forwardMessage(
      { userId: OWNER, guildId: "g1", channelId: "c1", text: "hi", attachments: [] },
      { token: "bot-tok", secret: "sek", intakeUrl: "http://loop/intake", fetchImpl },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://loop/intake");
    expect(calls[0].body.text).toBe("hi");
  });

  test("forwardInteraction posts { interaction } to /interact", async () => {
    const calls: Array<{ url: string; secret: string | null }> = [];
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      calls.push({
        url: String(url),
        secret: String((init as RequestInit).headers?.["x-eve-connector-secret"] ?? ""),
      });
      return new Response("ok");
    }) as typeof fetch;
    await forwardInteraction(
      { id: "i", type: 2, token: "t", userId: OWNER, channelId: "c1", data: {} },
      { secret: "sek", interactUrl: "http://loop/interact", fetchImpl },
    );
    expect(calls).toEqual([{ url: "http://loop/interact", secret: "sek" }]);
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
cd /root/dev/projects/Ei/packages/agent
bun add -d @types/bun
bun test tests/gateway.test.ts
```
Expected: FAIL — `mapInteractionCreate` / `forwardInteraction` don't exist yet.

- [ ] **Step 3: Implement parsing and dispatch**

In `packages/agent/lib/gateway/gateway.ts`, after `mapMessageCreate`, add:

```ts
export function mapInteractionCreate(d: unknown, ownerId: string): InteractionEvent | null {
  const raw = (d ?? {}) as {
    id?: unknown;
    type?: unknown;
    token?: unknown;
    channel_id?: unknown;
    guild_id?: unknown;
    member?: { user?: { id?: unknown } };
    user?: { id?: unknown };
    data?: { name?: unknown; custom_id?: unknown; options?: unknown[]; components?: unknown; resolved?: unknown };
  };
  const type = raw.type as InteractionKind | undefined;
  if (type !== 2 && type !== 4 && type !== 5) return null;
  const userId = String(raw.member?.user?.id ?? raw.user?.id ?? "");
  if (!userId || userId !== String(ownerId)) return null;
  if (typeof raw.id !== "string" || typeof raw.token !== "string" || typeof raw.channel_id !== "string") return null;
  const data = raw.data ?? {};
  return {
    id: raw.id,
    type,
    token: raw.token,
    userId,
    guildId: typeof raw.guild_id === "string" ? raw.guild_id : undefined,
    channelId: raw.channel_id,
    data: {
      name: typeof data.name === "string" ? data.name : undefined,
      custom_id: typeof data.custom_id === "string" ? data.custom_id : undefined,
      options: Array.isArray(data.options) ? data.options : undefined,
      components: data.components,
      resolved: data.resolved,
    },
  };
}
```

In the `DiscordGateway` `onmessage` switch, inside `case 0`, after the `MESSAGE_CREATE` branch add:

```ts
          } else if (data.t === "INTERACTION_CREATE") {
            const ev = mapInteractionCreate(data.d, this.cfg.ownerId);
            if (ev && this.cfg.onInteraction) this.cfg.onInteraction(ev);
          }
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/gateway.test.ts
```
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: forward discord interactions from the gateway to /interact"
```

---

### Task 3: DB layer and schema migration

**Files:**
- Create: `packages/agent/lib/db.ts`
- Modify: `packages/agent/package.json` (add deps and a `"test": "bun test"` script)
- Test: `packages/agent/tests/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `QueryResultLike`, `SqlExecutor`, `jsonValue(v): unknown`, `createPool(connectionString)`, `poolExecutor(pool)`, `getExecutor(): SqlExecutor | null`, `MIGRATE_SQL`, `migrate(ex)`. Consumed by Tasks 4–9.

- [ ] **Step 1: Add dependencies**

```bash
cd /root/dev/projects/Ei/packages/agent
bun add pg
bun add -d @types/pg pg-mem @types/bun
```

- [ ] **Step 2: Write the failing tests**

Create `packages/agent/tests/db.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { jsonValue, MIGRATE_SQL, migrate, type SqlExecutor } from "../lib/db";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  return { query: (text: string, params: unknown[] = []) => client.query(text, params) };
}

describe("jsonValue", () => {
  test("handles strings and objects", () => {
    expect(jsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(jsonValue({ a: 1 })).toEqual({ a: 1 });
    expect(jsonValue(null)).toBeNull();
  });
});

describe("migrate + schema", () => {
  test("creates ei_* tables and supports round-trips", async () => {
    const ex = await memExecutor();
    await migrate(ex);

    await ex.query(`insert into ei_providers (id, name, base_url, key_env) values ('groq', 'Groq', 'https://api.groq.com/openai/v1', 'PROVIDER_GROQ_API_KEY')`);
    const rows = await ex.query(`select id, name from ei_providers where id = $1`, ["groq"]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].name).toBe("Groq");

    await ex.query(`insert into ei_config (key, value, version) values ('active_model', $1::jsonb, 1)`, [
      JSON.stringify({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" }),
    ]);
    const cfg = await ex.query(`select value from ei_config where key = 'active_model'`);
    expect(jsonValue(cfg.rows[0].value)).toEqual({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" });

    // cascade delete: models cache follows the provider
    await ex.query(`insert into ei_models_cache (provider_id, model_id, source) values ('groq', 'm1', 'endpoint')`);
    await ex.query(`delete from ei_providers where id = 'groq'`);
    const left = await ex.query(`select count(*)::int as n from ei_models_cache`);
    expect(left.rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/db.test.ts
```
Expected: FAIL — `../lib/db` not found.

- [ ] **Step 4: Implement `lib/db.ts`**

```ts
// PostgreSQL access for ei_* tables. Gracefully absent when no connection string is set.
import pg from "pg";

export interface QueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query(text: string, params?: unknown[]): Promise<QueryResultLike>;
}

// pg and pg-mem disagree on jsonb return types; normalize here.
export function jsonValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: Number(process.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE ?? 4) });
}

export function poolExecutor(pool: pg.Pool): SqlExecutor {
  return {
    query: async (text, params = []) => {
      const r = await pool.query(text, params as never[]);
      return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? null };
    },
  };
}

let shared: pg.Pool | null = null;
let sharedUrl: string | undefined;

export function getExecutor(): SqlExecutor | null {
  const url = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  if (!shared || sharedUrl !== url) {
    shared?.end().catch(() => {});
    shared = createPool(url);
    sharedUrl = url;
  }
  return poolExecutor(shared);
}

export const MIGRATE_SQL = `
create table if not exists ei_providers (
  id text primary key,
  name text unique not null,
  base_url text not null,
  key_env text not null,
  headers_json jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text
);
create table if not exists ei_models_cache (
  provider_id text not null references ei_providers(id) on delete cascade,
  model_id text not null,
  label text,
  context_window int,
  output_window int,
  supports_tool_calls boolean,
  supports_reasoning boolean,
  supports_structured_output boolean,
  price_in numeric,
  price_out numeric,
  source text not null,
  fetched_at timestamptz not null default now(),
  primary key (provider_id, model_id)
);
create table if not exists ei_config (
  key text primary key,
  value jsonb not null,
  version bigint not null default 0
);
`;

export async function migrate(ex: SqlExecutor): Promise<void> {
  await ex.query(MIGRATE_SQL);
}
```

- [ ] **Step 5: Run tests and confirm they pass**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/db.test.ts
```
Expected: PASS (2 tests). If pg-mem rejects any DDL construct, document the exact construct it rejected and keep the production SQL as written — the DDL is exercised end-to-end in Task 9's boot smoke and the live E2E in Task 13.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: ei_* postgres schema and executor with migration"
```

---

### Task 4: Discovery — endpoint fetch, models.dev catalog, merge

**Files:**
- Create: `packages/agent/lib/models-dev.ts`
- Create: `packages/agent/lib/discovery.ts`
- Test: `packages/agent/tests/discovery.test.ts`

**Interfaces:**
- Consumes: Task 3 `SqlExecutor`, `jsonValue`; `DiscoverModelRow` is defined in `discovery.ts` and imported type-only by `models-dev.ts` (erased at runtime — no runtime cycle).
- Produces:
  - `discovery.ts`: `DiscoverModelRow`, `isChatCandidate(id): boolean`, `fetchEndpointModels(opts)`, `mergeDiscoveries(opts)`, `discoverModels(opts)` → `{ rows, endpointError }`.
  - `models-dev.ts`: `Catalog`, `CATALOG_URL`, `getCatalog({ ex?, fetchImpl?, force? })` → `{ data: Catalog; fetchedAt: number; fresh: boolean }`, `matchCatalogEntry(catalog, name, baseUrl)`, `catalogModelsToRows(entry, providerId)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/tests/discovery.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { catalogModelsToRows, matchCatalogEntry } from "../lib/models-dev";
import { discoverModels, fetchEndpointModels, isChatCandidate, mergeDiscoveries } from "../lib/discovery";

// slice of the real models.dev api.json (provider-level map)
const FIXTURE: Record<string, any> = {
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B",
        reasoning: false,
        tool_call: true,
        structured_output: true,
        limit: { context: 131072, output: 32768 },
        cost: { input: 0.59, output: 0.79 },
      },
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    models: {
      "deepseek-v4-flash": { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, tool_call: true, limit: { context: 1000000, output: 384000 } },
    },
  },
};

describe("isChatCandidate", () => {
  test("filters obvious non-chat ids", () => {
    expect(isChatCandidate("gpt-4o")).toBe(true);
    expect(isChatCandidate("text-embedding-3-small")).toBe(false);
    expect(isChatCandidate("whisper-1")).toBe(false);
    expect(isChatCandidate("gpt-image-2")).toBe(false);
    expect(isChatCandidate("llama-3.3-70b-versatile")).toBe(true);
  });
});

describe("matchCatalogEntry", () => {
  test("matches by provider name (case-insensitive)", () => {
    const m = matchCatalogEntry(FIXTURE, "Groq", "https://api.groq.com/openai/v1");
    expect(m?.id).toBe("groq");
  });
  test("matches by base-url host when name is unknown", () => {
    const m = matchCatalogEntry(FIXTURE, "my-deepseek", "https://api.deepseek.com/v1");
    expect(m?.id).toBe("deepseek");
  });
  test("returns null when nothing matches", () => {
    expect(matchCatalogEntry(FIXTURE, "nope", "https://nowhere.example.com")).toBeNull();
  });
});

describe("catalogModelsToRows", () => {
  test("maps fields with catalog source", () => {
    const rows = catalogModelsToRows(FIXTURE.groq, "groq");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model_id: "llama-3.3-70b-versatile",
      label: "Llama 3.3 70B",
      context_window: 131072,
      output_window: 32768,
      supports_tool_calls: true,
      supports_reasoning: false,
      supports_structured_output: true,
      price_in: 0.59,
      price_out: 0.79,
      source: "catalog",
    });
  });
});

describe("fetchEndpointModels", () => {
  test("parses a /models response", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ object: "list", data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 })) as typeof fetch;
    const out = await fetchEndpointModels({ baseUrl: "https://api.example.com/v1", fetchImpl });
    expect(out.error).toBeNull();
    expect(out.models).toEqual(["m1", "m2"]);
  });
  test("tolerates 404 with error string", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const out = await fetchEndpointModels({ baseUrl: "https://api.example.com/v1", fetchImpl });
    expect(out.models).toBeNull();
    expect(out.error).toContain("404");
  });
});

describe("mergeDiscoveries", () => {
  test("endpoint wins existence, catalog enriches, source both", () => {
    const rows = mergeDiscoveries({
      endpoint: ["m1", "m2"],
      catalog: [
        { model_id: "m2", label: "M2", context_window: 1000, output_window: 500, supports_tool_calls: true, supports_reasoning: false, supports_structured_output: null, price_in: null, price_out: null, source: "catalog" as const },
      ],
    });
    expect(rows.find((r) => r.model_id === "m1")).toMatchObject({ model_id: "m1", source: "endpoint" });
    const m2 = rows.find((r) => r.model_id === "m2")!;
    expect(m2.source).toBe("both");
    expect(m2.context_window).toBe(1000);
    expect(m2.supports_tool_calls).toBe(true);
  });
});

describe("discoverModels", () => {
  test("combines endpoint + catalog and leaves endpointError null on success", async () => {
    const fetchImpl = (async (url: unknown) =>
      String(url).includes("models.dev")
        ? new Response(JSON.stringify(FIXTURE), { status: 200 })
        : new Response(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }] }), { status: 200 })) as typeof fetch;
    const out = await discoverModels({
      baseUrl: "https://api.groq.com/openai/v1",
      name: "Groq",
      fetchImpl,
    });
    expect(out.endpointError).toBeNull();
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].source).toBe("both");
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/discovery.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `lib/models-dev.ts`**

```ts
// models.dev api.json catalog: fetch, match, and map. Shape verified 2026-08-10.
import { jsonValue, type SqlExecutor } from "./db";
import type { DiscoverModelRow } from "./discovery";

export interface CatalogProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

export interface CatalogEntry {
  id: string;
  name?: string;
  api?: string;
  models?: Record<string, CatalogProviderModel>;
}

export type Catalog = Record<string, CatalogEntry>;

export const CATALOG_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeProviderKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Stable slash from a base URL (strip trailing /v1 or /).
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v\d*\/?$/, "").replace(/\/+$/, "");
}

export function matchCatalogEntry(
  catalog: Catalog,
  name: string,
  baseUrl: string,
): { id: string; entry: CatalogEntry } | null {
  const key = normalizeProviderKey(name);
  const direct = Object.keys(catalog).find((k) => normalizeProviderKey(k) === key);
  if (direct) return { id: direct, entry: catalog[direct] };
  let host = "";
  try {
    host = new URL(normalizeBaseUrl(baseUrl)).host;
  } catch {
    return null;
  }
  const byApi = Object.keys(catalog).find((k) => {
    const api = catalog[k].api;
    if (!api) return false;
    try {
      return new URL(api).host === host;
    } catch {
      return false;
    }
  });
  if (byApi) return { id: byApi, entry: catalog[byApi] };
  return null;
}

export function catalogModelsToRows(entry: CatalogEntry | undefined, providerId: string): DiscoverModelRow[] {
  void providerId;
  if (!entry?.models) return [];
  return Object.entries(entry.models).map(([id, m]) => ({
    model_id: id,
    label: m.name ?? null,
    context_window: m.limit?.context ?? null,
    output_window: m.limit?.output ?? null,
    supports_tool_calls: m.tool_call ?? null,
    supports_reasoning: m.reasoning ?? null,
    supports_structured_output: m.structured_output ?? null,
    price_in: m.cost?.input ?? null,
    price_out: m.cost?.output ?? null,
    source: "catalog" as const,
  }));
}

interface CatalogSnapshot {
  data: Catalog;
  fetched_at: number;
}

let memoryCache: CatalogSnapshot | null = null;

async function loadFromDb(ex: SqlExecutor | undefined): Promise<CatalogSnapshot | null> {
  if (!ex) return null;
  try {
    const r = await ex.query(`select value from ei_config where key = 'catalog'`);
    if (!r.rows.length) return null;
    const parsed = jsonValue(r.rows[0].value) as Partial<CatalogSnapshot> | null;
    if (!parsed || typeof parsed.data !== "object" || parsed.data === null || typeof parsed.fetched_at !== "number") return null;
    return { data: parsed.data as Catalog, fetched_at: parsed.fetched_at };
  } catch {
    return null;
  }
}

export async function getCatalog(
  opts: { ex?: SqlExecutor; fetchImpl?: typeof fetch; force?: boolean } = {},
): Promise<{ data: Catalog; fetchedAt: number; fresh: boolean }> {
  const f = opts.fetchImpl ?? fetch;
  const now = Date.now();
  if (memoryCache && now - memoryCache.fetched_at < CATALOG_TTL_MS && !opts.force) {
    return { data: memoryCache.data, fetchedAt: memoryCache.fetched_at, fresh: true };
  }
  const dbSnapshot = await loadFromDb(opts.ex);
  if (dbSnapshot && now - dbSnapshot.fetched_at < CATALOG_TTL_MS && !opts.force) {
    memoryCache = dbSnapshot;
    return { data: dbSnapshot.data, fetchedAt: dbSnapshot.fetched_at, fresh: true };
  }
  const res = await f(CATALOG_URL);
  if (!res.ok) {
    const fallback = memoryCache ?? dbSnapshot;
    if (fallback) return { data: fallback.data, fetchedAt: fallback.fetched_at, fresh: false };
    throw new Error(`models.dev fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as Catalog;
  memoryCache = { data, fetched_at: now };
  if (opts.ex) {
    try {
      await opts.ex.query(
        `insert into ei_config (key, value, version) values ('catalog', $1::jsonb, 1)
         on conflict (key) do update set value = excluded.value, version = ei_config.version + 1`,
        [JSON.stringify({ data, fetched_at: now })],
      );
    } catch {
      // persistence is best-effort; the in-memory cache still serves
    }
  }
  return { data, fetchedAt: now, fresh: true };
}
```

- [ ] **Step 4: Implement `lib/discovery.ts`**

```ts
// Provider model discovery: endpoint /v1/models (source of truth) merged with models.dev catalog metadata.
import type { SqlExecutor } from "./db";
import { catalogModelsToRows, getCatalog, matchCatalogEntry } from "./models-dev";

export interface DiscoverModelRow {
  model_id: string;
  label: string | null;
  context_window: number | null;
  output_window: number | null;
  supports_tool_calls: boolean | null;
  supports_reasoning: boolean | null;
  supports_structured_output: boolean | null;
  price_in: number | null;
  price_out: number | null;
  source: "endpoint" | "catalog" | "both";
}

const NON_CHAT = /embedding|whisper|tts|speech|audio|image|rerank|moderation|dall-e|realtime|transcribe/i;

export function isChatCandidate(id: string): boolean {
  return !NON_CHAT.test(id);
}

export interface EndpointResult {
  models: string[] | null;
  error: string | null;
}

export async function fetchEndpointModels(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<EndpointResult> {
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const url = opts.baseUrl.replace(/\/+$/, "") + "/models";
  try {
    const res = await f(url, { headers });
    if (!res.ok) return { models: null, error: `GET ${url} -> ${res.status}` };
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(json.data)) return { models: null, error: "no data[] in /models response" };
    const ids = json.data.map((m) => String(m.id)).filter((id) => id && isChatCandidate(id));
    return { models: ids, error: null };
  } catch (err) {
    return { models: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function mergeDiscoveries(opts: { endpoint: string[] | null; catalog: DiscoverModelRow[] }): DiscoverModelRow[] {
  const catalogById = new Map(opts.catalog.map((r) => [r.model_id, r]));
  const merged = new Map<string, DiscoverModelRow>();
  for (const id of opts.endpoint ?? []) {
    const cat = catalogById.get(id);
    merged.set(id, {
      model_id: id,
      label: cat?.label ?? null,
      context_window: cat?.context_window ?? null,
      output_window: cat?.output_window ?? null,
      supports_tool_calls: cat?.supports_tool_calls ?? null,
      supports_reasoning: cat?.supports_reasoning ?? null,
      supports_structured_output: cat?.supports_structured_output ?? null,
      price_in: cat?.price_in ?? null,
      price_out: cat?.price_out ?? null,
      source: cat ? "both" : "endpoint",
    });
  }
  for (const cat of opts.catalog) {
    if (!merged.has(cat.model_id)) merged.set(cat.model_id, cat);
  }
  return [...merged.values()].sort((a, b) => a.model_id.localeCompare(b.model_id));
}

export interface DiscoverResult {
  rows: DiscoverModelRow[];
  endpointError: string | null;
}

export async function discoverModels(opts: {
  baseUrl: string;
  name: string;
  apiKey?: string;
  ex?: SqlExecutor;
  fetchImpl?: typeof fetch;
  forceCatalog?: boolean;
}): Promise<DiscoverResult> {
  const [endpoint, catalogResult] = await Promise.all([
    fetchEndpointModels({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, fetchImpl: opts.fetchImpl }),
    getCatalog({ ex: opts.ex, fetchImpl: opts.fetchImpl, force: opts.forceCatalog }),
  ]);
  const match = matchCatalogEntry(catalogResult.data, opts.name, opts.baseUrl);
  const catalogRows = match ? catalogModelsToRows(match.entry, match.id) : [];
  return { rows: mergeDiscoveries({ endpoint: endpoint.models, catalog: catalogRows }), endpointError: endpoint.error };
}
```

- [ ] **Step 5: Run tests and confirm they pass**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/discovery.test.ts
```
Expected: PASS (8 tests). If the in-memory 24 h catalog TTL crosses runs, pass `forceCatalog: true` in the `discoverModels` tests — no production behavior change.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: provider model discovery via /v1/models + models.dev merge"
```

---

### Task 5: Provider registry CRUD, active model, and language-model builder

**Files:**
- Create: `packages/agent/lib/providers.ts`
- Create: `packages/agent/lib/model.ts`
- Modify: `packages/agent/package.json` (add `@ai-sdk/openai`)
- Test: `packages/agent/tests/providers.test.ts`, `packages/agent/tests/model.test.ts`

**Interfaces:**
- Consumes: Task 3 `SqlExecutor`, `jsonValue`; Task 4 `DiscoverModelRow` (type-only).
- Produces:
  - `providers.ts`: `ProviderRow`, `ProviderInput`, `ActiveModelConfig`, `slugify`, `listProviders`, `getProvider`, `upsertProvider`, `deleteProvider`, `getActiveModel`, `setActiveModel`, `clearActiveIfProvider`, `listModelsForAutocomplete`, `cacheCounts`, `replaceModels`.
  - `model.ts`: `ModelSource`, `renderHeaders`, `buildLanguageModel` (Task 9 appends `resolveStepModel`).

- [ ] **Step 1: Add the SDK dependency**

```bash
cd /root/dev/projects/Ei/packages/agent
bun add @ai-sdk/openai@4.0.17
```

- [ ] **Step 2: Write the failing tests**

Create `packages/agent/tests/providers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { jsonValue, migrate, type SqlExecutor } from "../lib/db";
import {
  clearActiveIfProvider,
  deleteProvider,
  getActiveModel,
  getProvider,
  listProviders,
  setActiveModel,
  slugify,
  upsertProvider,
} from "../lib/providers";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

describe("providers", () => {
  test("slugify", () => {
    expect(slugify("Groq API")).toBe("groq-api");
    expect(slugify("OpenAI")).toBe("openai");
  });

  test("upsert/list/delete lifecycle", async () => {
    const ex = await memExecutor();
    await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "PROVIDER_GROQ_API_KEY" });
    const rows = await listProviders(ex);
    expect(rows).toHaveLength(1);
    const p = await getProvider(ex, "groq");
    expect(p?.key_env).toBe("PROVIDER_GROQ_API_KEY");
    await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "PROVIDER_GROQ_API_KEY", enabled: false });
    expect((await getProvider(ex, "groq"))?.enabled).toBe(false);
    const removed = await deleteProvider(ex, "groq");
    expect(removed?.id).toBe("groq");
    expect(await listProviders(ex)).toHaveLength(0);
  });

  test("active model set/clear with version bump", async () => {
    const ex = await memExecutor();
    await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "K" });
    await setActiveModel(ex, { provider_id: "groq", model_id: "m1" });
    expect(await getActiveModel(ex)).toEqual({ provider_id: "groq", model_id: "m1" });
    await setActiveModel(ex, null);
    expect(await getActiveModel(ex)).toBeNull();
  });

  test("clearActiveIfProvider clears only when active", async () => {
    const ex = await memExecutor();
    await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "K" });
    await upsertProvider(ex, { name: "Other", base_url: "https://api.other.com/v1", key_env: "K2" });
    await setActiveModel(ex, { provider_id: "groq", model_id: "m1" });
    await clearActiveIfProvider(ex, "groq");
    expect(await getActiveModel(ex)).toBeNull();
    await setActiveModel(ex, { provider_id: "other", model_id: "m2" });
    await clearActiveIfProvider(ex, "groq");
    expect(await getActiveModel(ex)).toEqual({ provider_id: "other", model_id: "m2" });
  });
});
```

Create `packages/agent/tests/model.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildLanguageModel, renderHeaders } from "../lib/model";

describe("renderHeaders", () => {
  test("interpolates ${env:NAME} refs and skips junk", () => {
    expect(renderHeaders(JSON.stringify({ "X-Key": "${env:PROVIDER_GROQ_API_KEY}", "X-Static": "v" }), {
      PROVIDER_GROQ_API_KEY: "sek",
    })).toEqual({ "X-Key": "sek", "X-Static": "v" });
    expect(renderHeaders("not json", {})).toBeUndefined();
    expect(renderHeaders(null, {})).toBeUndefined();
  });
});

describe("buildLanguageModel", () => {
  const src = {
    provider_id: "groq",
    base_url: "https://api.groq.com/openai/v1",
    key_env: "PROVIDER_GROQ_API_KEY",
    headers_json: null,
    model_id: "llama-3.3-70b-versatile",
  };
  test("returns null when the key env is missing", () => {
    expect(buildLanguageModel(src, {})).toBeNull();
  });
  test("returns a live LanguageModel when the key is present", () => {
    const lm = buildLanguageModel(src, { PROVIDER_GROQ_API_KEY: "sek" });
    expect(lm).not.toBeNull();
    expect(typeof (lm as any).doGenerate).toBe("function");
    expect((lm as any).modelId).toBe("llama-3.3-70b-versatile");
  });
});
```

Also append `jsonValue` usage to the provider active-model test — helper already used via `getActiveModel` internals; no extra assertions needed.

- [ ] **Step 3: Run tests and confirm they fail**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/providers.test.ts tests/model.test.ts
```
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `lib/providers.ts`**

```ts
// Provider registry CRUD + active-model config over SqlExecutor.
import { jsonValue, type SqlExecutor } from "./db";
import type { DiscoverModelRow } from "./discovery";

export interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  key_env: string;
  headers_json: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
}

export interface ProviderInput {
  name: string;
  base_url: string;
  key_env: string;
  headers_json?: string | null;
  enabled?: boolean;
}

export interface ActiveModelConfig {
  provider_id: string;
  model_id: string;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function rowOf(r: Record<string, unknown>): ProviderRow {
  return {
    id: String(r.id),
    name: String(r.name),
    base_url: String(r.base_url),
    key_env: String(r.key_env),
    headers_json: r.headers_json == null ? null : String(r.headers_json),
    enabled: Boolean(r.enabled),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    last_tested_at: r.last_tested_at == null ? null : String(r.last_tested_at),
    last_test_ok: r.last_test_ok == null ? null : Boolean(r.last_test_ok),
    last_test_error: r.last_test_error == null ? null : String(r.last_test_error),
  };
}

export async function listProviders(ex: SqlExecutor): Promise<ProviderRow[]> {
  const r = await ex.query(`select * from ei_providers order by name`);
  return r.rows.map(rowOf);
}

export async function getProvider(ex: SqlExecutor, idOrName: string): Promise<ProviderRow | null> {
  const r = await ex.query(`select * from ei_providers where id = $1 or name = $1 limit 1`, [idOrName]);
  return r.rows.length ? rowOf(r.rows[0]) : null;
}

export async function upsertProvider(ex: SqlExecutor, input: ProviderInput): Promise<ProviderRow> {
  const id = slugify(input.name);
  const headers = input.headers_json ?? null;
  const enabled = input.enabled ?? true;
  await ex.query(
    `insert into ei_providers (id, name, base_url, key_env, headers_json, enabled)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (name) do update set
       base_url = excluded.base_url,
       key_env = excluded.key_env,
       headers_json = excluded.headers_json,
       enabled = excluded.enabled,
       updated_at = now()`,
    [id, input.name, input.base_url, input.key_env, headers, enabled],
  );
  const got = await getProvider(ex, id);
  if (!got) throw new Error("provider write failed");
  return got;
}

export async function deleteProvider(ex: SqlExecutor, idOrName: string): Promise<ProviderRow | null> {
  const existing = await getProvider(ex, idOrName);
  if (!existing) return null;
  await ex.query(`delete from ei_providers where id = $1`, [existing.id]);
  return existing;
}

export async function getActiveModel(ex: SqlExecutor): Promise<ActiveModelConfig | null> {
  const r = await ex.query(`select value from ei_config where key = 'active_model'`);
  if (!r.rows.length) return null;
  const v = jsonValue(r.rows[0].value) as Partial<ActiveModelConfig> | null;
  if (!v || typeof v.provider_id !== "string" || typeof v.model_id !== "string") return null;
  return { provider_id: v.provider_id, model_id: v.model_id };
}

export async function setActiveModel(ex: SqlExecutor, active: ActiveModelConfig | null): Promise<void> {
  await ex.query(
    `insert into ei_config (key, value, version) values ('active_model', $1::jsonb, 1)
     on conflict (key) do update set value = excluded.value, version = ei_config.version + 1`,
    [JSON.stringify(active)],
  );
}

export async function clearActiveIfProvider(ex: SqlExecutor, providerId: string): Promise<void> {
  const active = await getActiveModel(ex);
  if (active?.provider_id === providerId) await setActiveModel(ex, null);
}

export interface AutocompleteModel {
  provider_id: string;
  model_id: string;
  label: string | null;
  context_window: number | null;
  supports_tool_calls: boolean | null;
}

export async function listModelsForAutocomplete(ex: SqlExecutor, query: string): Promise<AutocompleteModel[]> {
  const r = await ex.query(
    `select p.id as provider_id, m.model_id, m.label, m.context_window, m.supports_tool_calls
     from ei_models_cache m join ei_providers p on p.id = m.provider_id
     where p.enabled and m.model_id ilike $1
     order by m.model_id limit 25`,
    [`%${query}%`],
  );
  return r.rows.map((row) => ({
    provider_id: String(row.provider_id),
    model_id: String(row.model_id),
    label: row.label == null ? null : String(row.label),
    context_window: row.context_window == null ? null : Number(row.context_window),
    supports_tool_calls: row.supports_tool_calls == null ? null : Boolean(row.supports_tool_calls),
  }));
}

export interface CacheCounts {
  endpoint: number;
  catalog: number;
}

export async function cacheCounts(ex: SqlExecutor, providerId: string): Promise<CacheCounts> {
  const r = await ex.query(`select source, count(*)::int as n from ei_models_cache where provider_id = $1 group by source`, [providerId]);
  const out: CacheCounts = { endpoint: 0, catalog: 0 };
  for (const row of r.rows) {
    if (row.source === "endpoint") out.endpoint = Number(row.n);
    if (row.source === "catalog") out.catalog = Number(row.n);
  }
  return out;
}

export async function replaceModels(ex: SqlExecutor, providerId: string, rows: DiscoverModelRow[]): Promise<void> {
  await ex.query(`delete from ei_models_cache where provider_id = $1`, [providerId]);
  for (const row of rows) {
    await ex.query(
      `insert into ei_models_cache
        (provider_id, model_id, label, context_window, output_window, supports_tool_calls, supports_reasoning, supports_structured_output, price_in, price_out, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [providerId, row.model_id, row.label, row.context_window, row.output_window, row.supports_tool_calls, row.supports_reasoning, row.supports_structured_output, row.price_in, row.price_out, row.source],
    );
  }
}
```

- [ ] **Step 5: Implement `lib/model.ts`**

```ts
// Build a live AI SDK LanguageModel for a provider from its config + env.
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export interface ModelSource {
  provider_id: string;
  base_url: string;
  key_env: string;
  headers_json: string | null;
  model_id: string;
}

export function renderHeaders(
  headersJson: string | null,
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!headersJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(headersJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    out[k] = v.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_m, name: string) => env[name] ?? "");
  }
  return out;
}

export function buildLanguageModel(
  src: ModelSource,
  env: Record<string, string | undefined>,
): LanguageModel | null {
  const apiKey = env[src.key_env];
  if (!apiKey) return null;
  const headers = renderHeaders(src.headers_json, env);
  const openai = createOpenAI({
    name: src.provider_id,
    baseURL: src.base_url,
    apiKey,
    headers,
  });
  return openai.chat(src.model_id);
}
```

- [ ] **Step 6: Run tests and confirm they pass**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/providers.test.ts tests/model.test.ts
```
Expected: PASS (model: 3, providers: 3). If pg-mem behaves differently on `count(*)::int` or boolean binds, adjust the test assertion to `Number()`-bind the value, not the production SQL.

- [ ] **Step 7: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: provider registry crud, active model, language-model builder"
```

---

### Task 6: Interaction protocol helpers

**Files:**
- Create: `packages/agent/lib/interactions.ts`
- Test: `packages/agent/tests/interactions.test.ts`

**Interfaces:**
- Consumes: Task 2 `InteractionEvent` (type-only).
- Produces: `DISCORD_API`, `EPHEMERAL`, `isOwner`, `respondModal`, `deferredAck`, `respondAutocomplete`, `followupEphemeral`, `modalValues`, `parseOptions`, `subcommandOf`. Consumed by Tasks 7–8.

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/tests/interactions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  deferredAck,
  followupEphemeral,
  isOwner,
  modalValues,
  parseOptions,
  respondAutocomplete,
  respondModal,
  subcommandOf,
} from "../lib/interactions";

const i = { id: "i1", token: "tok", channelId: "c1", userId: "123" } as const;

describe("isOwner", () => {
  test("compares string ids", () => {
    expect(isOwner(i, "123")).toBe(true);
    expect(isOwner(i, "456")).toBe(false);
  });
});

describe("parseOptions / subcommandOf", () => {
  test("flattens subcommand options", () => {
    const parsed = parseOptions([{ name: "model", value: "m1" }, { name: "enabled", value: true }]);
    expect(parsed).toEqual({ model: "m1", enabled: true });
  });
  test("subcommandOf pulls the nested command name", () => {
    expect(subcommandOf([{ type: 1, name: "use", options: [{ name: "model", value: "m1" }] }])).toBe("use");
    expect(subcommandOf(undefined)).toBeUndefined();
    expect(subcommandOf([{ type: 3, name: "foo" }])).toBeUndefined();
  });
});

describe("modalValues", () => {
  test("reads text input values", () => {
    const d = {
      components: [
        { components: [{ custom_id: "name", type: 4, value: "Groq" }, { custom_id: "key_env", type: 4, value: "PROVIDER_GROQ_API_KEY" }] },
        { components: [{ custom_id: "base_url", type: 4, value: "https://api.groq.com/openai/v1" }] },
      ],
    };
    expect(modalValues(d)).toEqual({
      name: "Groq",
      key_env: "PROVIDER_GROQ_API_KEY",
      base_url: "https://api.groq.com/openai/v1",
    });
  });
});

describe("protocol calls", () => {
  test("respondModal posts type 9 with the modal", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response("", { status: 204 });
    }) as typeof fetch;
    await respondModal(i, { customId: "provider_add", title: "Add", components: [] }, { fetchImpl });
    expect(bodies[0].type).toBe(9);
    expect((bodies[0].data as any).custom_id).toBe("provider_add");
  });
  test("deferredAck posts type 5 with ephemeral flag", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response("", { status: 204 });
    }) as typeof fetch;
    await deferredAck(i, { fetchImpl });
    expect(bodies[0]).toEqual({ type: 5, data: { flags: 1 << 6 } });
  });
  test("followupEphemeral PATCHes content with the app token url", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      const u = String(url);
      const initObj = init as RequestInit;
      calls.push({ url: u, method: initObj.method ?? "GET", body: JSON.parse(String(initObj.body)) });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await followupEphemeral("app1", i, "hello", { fetchImpl });
    expect(calls[0].url).toContain("/webhooks/app1/tok/messages/@original");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body.content).toBe("hello");
  });
  test("respondAutocomplete posts type 8 with choices", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response("", { status: 204 });
    }) as typeof fetch;
    await respondAutocomplete(i, [{ name: "a", value: "v" }], { fetchImpl });
    expect(bodies[0].type).toBe(8);
    expect((bodies[0].data as any).choices).toEqual([{ name: "a", value: "v" }]);
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/interactions.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/interactions.ts`**

```ts
// Discord interaction REST protocol (v10). All network calls take an injectable fetch.
import type { InteractionEvent } from "./gateway/gateway";

export const DISCORD_API = "https://discord.com/api/v10";
export const EPHEMERAL = 1 << 6;

export function isOwner(interaction: InteractionEvent, ownerId: string): boolean {
  return interaction.userId === String(ownerId);
}

export interface OptionValue {
  name?: string;
  value?: unknown;
  type?: number;
  options?: unknown[];
}

export function parseOptions(options: OptionValue[] | undefined): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const o of options ?? []) {
    if (typeof o.name !== "string") continue;
    if (typeof o.value === "string" || typeof o.value === "boolean") out[o.name] = o.value;
  }
  return out;
}

export function subcommandOf(options: OptionValue[] | undefined): string | undefined {
  const first = options?.[0];
  if (first && first.type === 1 && typeof first.name === "string") return first.name;
  return undefined;
}

export interface ModalTextInput {
  custom_id: string;
  type: number;
  value?: string;
}

export function modalValues(data: { components?: Array<{ components?: ModalTextInput[] }> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of data.components ?? []) {
    for (const comp of row.components ?? []) {
      if (comp.type === 4 && typeof comp.custom_id === "string" && typeof comp.value === "string") {
        out[comp.custom_id] = comp.value;
      }
    }
  }
  return out;
}

async function postCallback(
  interaction: { id: string; token: string },
  body: unknown,
  opts: { fetchImpl?: typeof fetch },
): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  return f(`${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface TextInputSpec {
  type: number;
  custom_id: string;
  label: string;
  style?: number;
  required?: boolean;
  value?: string;
  min_length?: number;
  max_length?: number;
}

export async function respondModal(
  interaction: { id: string; token: string },
  modal: { customId: string; title: string; components: TextInputSpec[] },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await postCallback(interaction, { type: 9, data: { custom_id: modal.customId, title: modal.title, components: [{ type: 1, components: modal.components }] } }, opts);
}

export async function deferredAck(
  interaction: { id: string; token: string },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await postCallback(interaction, { type: 5, data: { flags: EPHEMERAL } }, opts);
}

export async function respondAutocomplete(
  interaction: { id: string; token: string },
  choices: Array<{ name: string; value: string }>,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await postCallback(interaction, { type: 8, data: { choices } }, opts);
}

export async function followupEphemeral(
  appId: string,
  interaction: { token: string },
  content: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  return f(`${DISCORD_API}/webhooks/${appId}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/interactions.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: discord interaction REST helpers (modal, ack, autocomplete, followup)"
```

---

### Task 7: Admin service (`serviceAdminEvent`) + `/interact` channel route

**Files:**
- Create: `packages/agent/lib/admin.ts`
- Create: `packages/agent/agent/channels/admin.ts`
- Create: `packages/agent/lib/commands.ts` (skeleton; Task 8 replaces the body)
- Test: `packages/agent/tests/admin.test.ts`

**Interfaces:**
- Consumes: Task 2 `InteractionEvent`; Task 3 `getExecutor`, `migrate`, `SqlExecutor`; Task 6 protocol helpers.
- Produces: `serviceAdminEvent(interaction, deps: AdminDeps): Promise<void>` — fully awaited (deterministic in tests); `AdminDeps = { appId; ex; env; fetchImpl?; commands: CommandModule }`. `CommandModule` shape: `{ handleCommand(deps: CommandDeps, command, options) → { reply }; handleAutocomplete(deps, command, query) → { choices }; handleModalSubmit(deps, customId, values) → { reply } }`. Also `packages/agent/lib/commands.ts` skeleton defining `CommandDeps = { ex; env; fetchImpl? }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/tests/admin.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { serviceAdminEvent } from "../lib/admin";
import type { InteractionEvent } from "../lib/gateway/gateway";
import type { CommandModule } from "../lib/admin";

function fakeCommands(overrides: Partial<CommandModule> = {}): CommandModule {
  return {
    handleCommand: async () => ({ reply: "done" }),
    handleAutocomplete: async () => ({ choices: [{ name: "provider/model — 128k ctx", value: "model-id" }] }),
    handleModalSubmit: async () => ({ reply: "added" }),
    ...overrides,
  };
}

function captureFetch() {
  const calls: Array<{ body: Record<string, any> }> = [];
  const fetchImpl = (async (_url: unknown, init?: unknown) => {
    calls.push({ body: JSON.parse(String((init as RequestInit).body)) });
    return new Response("", { status: 204 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function deps(overrides: { commands?: CommandModule; fetchImpl?: typeof fetch } = {}) {
  const ex = { query: async () => ({ rows: [], rowCount: 0 }) } as any;
  return {
    appId: "app1",
    ex,
    env: {},
    fetchImpl: overrides.fetchImpl,
    commands: overrides.commands ?? fakeCommands(),
  };
}

const owner = (data: Record<string, unknown>): InteractionEvent => ({
  id: "i",
  type: 2,
  token: "tok",
  userId: "1",
  channelId: "c",
  data: data as any,
});

describe("serviceAdminEvent", () => {
  test("command: defers, runs, follows up", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      owner({ options: [{ type: 1, name: "list", options: [] }] }),
      deps({ fetchImpl }),
    );
    expect(calls.map((c) => c.body.type)).toEqual([5]);
    expect(calls[1].body.content).toBe("done");
    expect(calls).toHaveLength(2);
  });

  test("add command: opens the provider_add modal", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      owner({ options: [{ type: 1, name: "add", options: [] }] }),
      deps({ fetchImpl }),
    );
    expect(calls[0].body.type).toBe(9);
    expect(calls[0].body.data.custom_id).toBe("provider_add");
    expect(calls).toHaveLength(1);
  });

  test("modal submit: acks and runs the add handler", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      {
        id: "i",
        type: 5,
        token: "tok",
        userId: "1",
        channelId: "c",
        data: { custom_id: "provider_add", components: [{ components: [{ type: 4, custom_id: "name", value: "Groq" }] }] } as any,
      },
      deps({ fetchImpl }),
    );
    expect(calls[0].body.type).toBe(5);
    expect(calls[1].body.content).toBe("added");
  });

  test("autocomplete: answers type 8 from the cache", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      {
        id: "i",
        type: 4,
        token: "tok",
        userId: "1",
        channelId: "c",
        data: { options: [{ type: 1, name: "use", options: [{ type: 3, name: "model", value: "ll" }] }] } as any,
      },
      deps({ fetchImpl }),
    );
    expect(calls[0].body.type).toBe(8);
    expect(calls[0].body.data.choices).toHaveLength(1);
  });

  test("errors reply through the followup", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      owner({ options: [{ type: 1, name: "bogus", options: [] }] }),
      deps({ commands: fakeCommands({ handleCommand: async () => { throw new Error("boom"); } }), fetchImpl }),
    );
    expect(calls[0].body.type).toBe(5);
    expect(calls[1].body.content).toContain("Error: boom");
  });

  test("unknown subcommand defers and follows up with the handler reply", async () => {
    const { calls, fetchImpl } = captureFetch();
    await serviceAdminEvent(
      owner({ options: [{ type: 1, name: "bogus", options: [] }] }),
      deps({ commands: fakeCommands({ handleCommand: async () => ({ reply: "Unknown provider command." }) }), fetchImpl }),
    );
    expect(calls[1].body.content).toBe("Unknown provider command.");
  });
});
```

Note: the first "command" test asserts `type: 5` first then content; the `bogus` tests use the same flow and only differ in command name — keep all six tests distinct by command name/content as written.

- [ ] **Step 2: Run tests and confirm they fail**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/admin.test.ts
```
Expected: FAIL — `lib/admin` not found.

- [ ] **Step 3: Implement `lib/commands.ts` (skeleton)**

Create `packages/agent/lib/commands.ts`:

```ts
// Slash-command handlers for the BYOK provider registry (full body in Task 8).
import type { SqlExecutor } from "./db";

export interface CommandDeps {
  ex: SqlExecutor;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export async function handleCommand(_deps: CommandDeps, _command: string, _options: Record<string, string | boolean>): Promise<{ reply: string }> {
  return { reply: "unknown command" };
}

export async function handleAutocomplete(_deps: CommandDeps, _command: string, _query: string): Promise<{ choices: Array<{ name: string; value: string }> }> {
  return { choices: [] };
}

export async function handleModalSubmit(_deps: CommandDeps, _customId: string, _values: Record<string, string>): Promise<{ reply: string }> {
  return { reply: "unknown modal" };
}
```

- [ ] **Step 4: Implement `lib/admin.ts`**

```ts
// Interaction orchestration: one entry point services every admin interaction event.
import type { SqlExecutor } from "./db";
import type { InteractionEvent } from "./gateway/gateway";
import {
  deferredAck,
  followupEphemeral,
  modalValues,
  parseOptions,
  respondAutocomplete,
  respondModal,
  subcommandOf,
} from "./interactions";
import type { CommandDeps } from "./commands";

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export interface CommandModule {
  handleCommand(deps: CommandDeps, command: string, options: Record<string, string | boolean>): Promise<{ reply: string }>;
  handleAutocomplete(deps: CommandDeps, command: string, query: string): Promise<{ choices: AutocompleteChoice[] }>;
  handleModalSubmit(deps: CommandDeps, customId: string, values: Record<string, string>): Promise<{ reply: string }>;
}

export interface AdminDeps {
  appId: string;
  ex: SqlExecutor;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  commands: CommandModule;
}

const TEXT_INPUT = { type: 4, style: 1 };

export async function serviceAdminEvent(interaction: InteractionEvent, deps: AdminDeps): Promise<void> {
  const f = deps.fetchImpl;
  const commandDeps: CommandDeps = { ex: deps.ex, env: deps.env, fetchImpl: f };
  const options = interaction.data.options ?? [];

  if (interaction.type === 4) {
    const command = subcommandOf(options);
    const inner = options[0] && (options[0] as { type?: number; options?: unknown[] }).type === 1
      ? (options[0] as { options?: unknown[] }).options
      : options;
    const parsed = parseOptions(inner as never);
    const query = typeof parsed.model === "string" ? parsed.model : "";
    const { choices } = await deps.commands
      .handleAutocomplete(commandDeps, command ?? "", query)
      .catch(() => ({ choices: [] as AutocompleteChoice[] }));
    await respondAutocomplete(interaction, choices.slice(0, 25), { fetchImpl: f });
    return;
  }

  if (interaction.type === 5) {
    try {
      await deferredAck(interaction, { fetchImpl: f });
      const values = modalValues((interaction.data.components as never) ?? { components: [] });
      const { reply } = await deps.commands.handleModalSubmit(commandDeps, interaction.data.custom_id ?? "", values);
      await followupEphemeral(deps.appId, interaction, reply, { fetchImpl: f });
    } catch (err) {
      await followupEphemeral(deps.appId, interaction, `Error: ${err instanceof Error ? err.message : String(err)}`, { fetchImpl: f }).catch(() => {});
    }
    return;
  }

  // type 2 command
  try {
    const command = subcommandOf(options);
    if (command === "add") {
      await respondModal(interaction, {
        customId: "provider_add",
        title: "Add BYOK provider",
        components: [
          { ...TEXT_INPUT, custom_id: "name", label: "Provider name", required: true, min_length: 1, max_length: 40 },
          { ...TEXT_INPUT, custom_id: "base_url", label: "Base URL (OpenAI-compatible)", required: true, max_length: 200 },
          { ...TEXT_INPUT, custom_id: "key_env", label: "Doppler secret name (e.g. PROVIDER_GROQ_API_KEY)", required: true, max_length: 80 },
          { ...TEXT_INPUT, custom_id: "headers", label: "Extra headers JSON (optional; ${env:NAME} refs)", required: false, max_length: 500 },
        ],
      }, { fetchImpl: f });
      return;
    }
    await deferredAck(interaction, { fetchImpl: f });
    const inner = options[0] && (options[0] as { type?: number; options?: unknown[] }).type === 1
      ? (options[0] as { options?: unknown[] }).options
      : options;
    const parsed = parseOptions(inner as never);
    const { reply } = await deps.commands.handleCommand(commandDeps, command ?? "", parsed);
    await followupEphemeral(deps.appId, interaction, reply, { fetchImpl: f });
  } catch (err) {
    await followupEphemeral(deps.appId, interaction, `Error: ${err instanceof Error ? err.message : String(err)}`, { fetchImpl: f }).catch(() => {});
  }
}
```

- [ ] **Step 5: Add the channel route**

Create `packages/agent/agent/channels/admin.ts`:

```ts
import { defineChannel, POST } from "eve/channels";
import { getExecutor, migrate, type SqlExecutor } from "../../lib/db";
import { serviceAdminEvent, type CommandModule } from "../../lib/admin";
import * as commands from "../../lib/commands";
import type { InteractionEvent } from "../../lib/gateway/gateway";

const commandModule: CommandModule = {
  handleCommand: commands.handleCommand,
  handleAutocomplete: commands.handleAutocomplete,
  handleModalSubmit: commands.handleModalSubmit,
};

export default defineChannel({
  routes: [
    POST("/interact", async (request) => {
      if (request.headers.get("x-eve-connector-secret") !== process.env.EVE_CONNECTOR_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const body = (await request.json()) as { interaction?: InteractionEvent };
      const interaction = body.interaction;
      if (!interaction) return new Response("bad request", { status: 400 });
      const ownerId = process.env.AGENT_OWNER_DISCORD_ID ?? "";
      if (ownerId && interaction.userId !== ownerId) return new Response("ignored", { status: 200 });
      const ex = getExecutor();
      if (!ex) return new Response("no database", { status: 200 }); // config surface unavailable; the agent still runs on the fallback model
      await migrate(ex).catch(() => {});
      await serviceAdminEvent(interaction, {
        appId: process.env.DISCORD_APP_ID ?? "",
        ex: ex as SqlExecutor,
        env: process.env as Record<string, string | undefined>,
        fetchImpl: fetch,
        commands: commandModule,
      });
      return new Response("ok", { status: 200 });
    }),
  ],
  events: {},
});
```

- [ ] **Step 6: Run tests and the typecheck**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/admin.test.ts
bunx tsc -p tsconfig.json
```
Expected: 6 tests PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: /interact admin route with interaction orchestration"
```

---

### Task 8: Provider command handlers

**Files:**
- Modify: `packages/agent/lib/commands.ts` (replace the skeleton)
- Test: `packages/agent/tests/commands.test.ts`

**Interfaces:**
- Consumes: Task 4 `discoverModels`; Task 5 `providers.*`, `buildLanguageModel`, `getActiveModel`; `isPublicHttpUrl` from `@ei/shared`; `generateText` from `ai`.
- Produces: the real `CommandModule` (same signatures as the Task 7 skeleton) plus `suggestModels(ex, query)`, `formatProviderList(ex, env)`, `KEY_ENV_PATTERN`.

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/tests/commands.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { jsonValue, migrate, type SqlExecutor } from "../lib/db";
import { replaceModels, setActiveModel, upsertProvider } from "../lib/providers";
import { formatProviderList, handleAutocomplete, handleCommand, handleModalSubmit, suggestModels } from "../lib/commands";

async function memExecutor(): Promise<SqlExecutor> {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  const ex: SqlExecutor = { query: (text: string, params: unknown[] = []) => client.query(text, params) };
  await migrate(ex);
  return ex;
}

const ENV: Record<string, string | undefined> = { PROVIDER_GROQ_API_KEY: "sek" };

const FIXTURE: Record<string, any> = {
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B",
        tool_call: true,
        limit: { context: 131072, output: 32768 },
      },
    },
  },
};

async function seed(ex: SqlExecutor, opts: { models?: boolean } = { models: true }) {
  await upsertProvider(ex, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key_env: "PROVIDER_GROQ_API_KEY" });
  if (opts.models) {
    await replaceModels(ex, "groq", [
      { model_id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", context_window: 131072, output_window: 32768, supports_tool_calls: true, supports_reasoning: false, supports_structured_output: true, price_in: 0.59, price_out: 0.79, source: "catalog" as const },
    ]);
  }
}

describe("suggestModels / autocomplete", () => {
  test("suggests cached models with labels", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const rows = await suggestModels(ex, "llama");
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("llama-3.3-70b-versatile");
    expect(rows[0].name).toContain("Llama 3.3 70B");
  });
  test("handleAutocomplete wraps choices", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { choices } = await handleAutocomplete({ ex, env: ENV }, "use", "llama");
    expect(choices[0].value).toBe("llama-3.3-70b-versatile");
  });
});

describe("handleCommand", () => {
  test("list formats providers with key status", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { reply } = await handleCommand({ ex, env: ENV }, "list", {});
    expect(reply).toContain("Groq");
    expect(reply).toContain("key: set");
    expect(reply).toContain("models: 1");
  });
  test("use sets the active model", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { reply } = await handleCommand({ ex, env: ENV }, "use", { model: "llama-3.3-70b-versatile" });
    expect(reply).toContain("llama-3.3-70b-versatile");
    const cfg = await ex.query(`select value from ei_config where key = 'active_model'`);
    expect(jsonValue(cfg.rows[0].value)).toEqual({ provider_id: "groq", model_id: "llama-3.3-70b-versatile" });
  });
  test("use rejects an unknown model id", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { reply } = await handleCommand({ ex, env: ENV }, "use", { model: "nope" });
    expect(reply.toLowerCase()).toContain("unknown");
  });
  test("remove clears active", async () => {
    const ex = await memExecutor();
    await seed(ex);
    await setActiveModel(ex, { provider_id: "groq", model_id: "llama-3.3-70b-versatile" });
    const { reply } = await handleCommand({ ex, env: ENV }, "remove", { name: "Groq" });
    expect(reply).toContain("removed");
    const cfg = await ex.query(`select value from ei_config where key = 'active_model'`);
    expect(jsonValue(cfg.rows[0].value)).toBeNull();
  });
  test("edit rejects a private base_url", async () => {
    const ex = await memExecutor();
    await seed(ex, { models: false });
    const { reply } = await handleCommand({ ex, env: ENV }, "edit", { name: "Groq", base_url: "http://localhost:9999/v1" });
    expect(reply.toLowerCase()).toContain("url");
  });
  test("test reports when the key env is missing", async () => {
    const ex = await memExecutor();
    await seed(ex);
    const { reply } = await handleCommand({ ex, env: {} }, "test", { name: "Groq" });
    expect(reply).toContain("PROVIDER_GROQ_API_KEY");
  });
});

describe("handleModalSubmit", () => {
  test("provider_add registers and discovers", async () => {
    const ex = await memExecutor();
    const fetchImpl = (async (url: unknown) =>
      String(url).includes("models.dev")
        ? new Response(JSON.stringify(FIXTURE), { status: 200 })
        : new Response("nope", { status: 404 })) as typeof fetch;
    const { reply } = await handleModalSubmit({ ex, env: ENV, fetchImpl }, "provider_add", {
      name: "Groq",
      base_url: "https://api.groq.com/openai/v1",
      key_env: "PROVIDER_GROQ_API_KEY",
    });
    expect(reply).toContain("Groq");
    expect(reply).toContain("Registered");
  });
});

describe("formatProviderList", () => {
  test("marks the active provider", async () => {
    const ex = await memExecutor();
    await seed(ex);
    await setActiveModel(ex, { provider_id: "groq", model_id: "llama-3.3-70b-versatile" });
    const text = await formatProviderList(ex, ENV);
    expect(text).toContain("ACTIVE");
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/commands.test.ts
```
Expected: FAIL — skeleton returns "unknown command".

- [ ] **Step 3: Replace `lib/commands.ts`**

```ts
// Slash-command handlers for the BYOK provider registry.
import { isPublicHttpUrl } from "@ei/shared";
import { generateText } from "ai";
import type { SqlExecutor } from "./db";
import { discoverModels, type DiscoverModelRow } from "./discovery";
import { buildLanguageModel } from "./model";
import {
  cacheCounts,
  clearActiveIfProvider,
  deleteProvider,
  getActiveModel,
  getProvider,
  listModelsForAutocomplete,
  listProviders,
  replaceModels,
  setActiveModel,
  slugify,
  upsertProvider,
} from "./providers";

export interface CommandDeps {
  ex: SqlExecutor;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export const KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function isValidKeyEnv(v: string): boolean {
  return KEY_ENV_PATTERN.test(v);
}

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export async function suggestModels(ex: SqlExecutor, query: string): Promise<AutocompleteChoice[]> {
  const rows = await listModelsForAutocomplete(ex, query.trim());
  return rows.map((r) => {
    const label = r.label ? ` — ${r.label}` : "";
    const ctx = r.context_window != null ? `, ${(r.context_window / 1000).toFixed(0)}k ctx` : "";
    return {
      name: `${r.provider_id}/${r.model_id}${label}${ctx}`.slice(0, 100),
      value: r.model_id,
    };
  });
}

async function runDiscovery(deps: CommandDeps, providerId: string): Promise<DiscoverModelRow[]> {
  const p = await getProvider(deps.ex, providerId);
  if (!p) throw new Error("provider not found");
  const apiKey = deps.env[p.key_env];
  const result = await discoverModels({
    baseUrl: p.base_url,
    name: p.name,
    apiKey,
    ex: deps.ex,
    fetchImpl: deps.fetchImpl,
  });
  await replaceModels(deps.ex, p.id, result.rows);
  return result.rows;
}

export async function handleAutocomplete(deps: CommandDeps, _command: string, query: string): Promise<{ choices: AutocompleteChoice[] }> {
  const choices = await suggestModels(deps.ex, query);
  return { choices: choices.slice(0, 25) };
}

export async function handleCommand(
  deps: CommandDeps,
  command: string,
  options: Record<string, string | boolean>,
): Promise<{ reply: string }> {
  switch (command) {
    case "list":
      return { reply: await formatProviderList(deps.ex, deps.env) };
    case "edit":
      return editProvider(deps, options);
    case "remove":
      return removeProvider(deps, options);
    case "test":
      return testProvider(deps, options);
    case "refresh":
      return refreshProvider(deps, options);
    case "use":
      return useModel(deps, options);
    default:
      return { reply: "Unknown provider command." };
  }
}

export async function handleModalSubmit(
  deps: CommandDeps,
  customId: string,
  values: Record<string, string>,
): Promise<{ reply: string }> {
  if (customId !== "provider_add") return { reply: "Unknown modal." };
  const name = (values.name ?? "").trim();
  const baseUrl = (values.base_url ?? "").trim();
  const keyEnv = (values.key_env ?? "").trim();
  if (!name || !baseUrl || !keyEnv) return { reply: "name, base_url, and key_env are required." };
  if (!isPublicHttpUrl(baseUrl)) return { reply: "base_url must be a public http(s) URL." };
  if (!isValidKeyEnv(keyEnv)) return { reply: "key_env must look like an env var name (e.g. PROVIDER_GROQ_API_KEY)." };
  const headers = (values.headers ?? "").trim() || null;
  if (headers && !isValidJson(headers)) return { reply: "headers must be valid JSON." };
  try {
    const existing = await getProvider(deps.ex, slugify(name));
    if (existing) return { reply: `Provider "${name}" already exists. Use /provider edit.` };
    await upsertProvider(deps.ex, { name, base_url: baseUrl, key_env: keyEnv, headers_json: headers });
    const rows = await runDiscovery(deps, slugify(name));
    const keySet = Boolean(deps.env[keyEnv]);
    const tip = keySet ? "" : `\nSet its secret with: doppler secrets set ${keyEnv}=...`;
    return { reply: `Registered "${name}" at ${baseUrl}. ${rows.length} model(s) cached.${tip}` };
  } catch (err) {
    return { reply: `Add failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function editProvider(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const name = String(options.name ?? "");
  const p = await getProvider(deps.ex, name);
  if (!p) return { reply: `No provider named "${name}".` };
  const next = {
    name: p.name,
    base_url: typeof options.base_url === "string" ? options.base_url : p.base_url,
    key_env: typeof options.key_env === "string" ? options.key_env : p.key_env,
    headers_json: p.headers_json,
    enabled: typeof options.enabled === "boolean" ? options.enabled : p.enabled,
  };
  if (!isPublicHttpUrl(next.base_url)) return { reply: "base_url must be a public http(s) URL." };
  if (!isValidKeyEnv(next.key_env)) return { reply: "key_env must look like an env var name." };
  const baseUrlChanged = next.base_url !== p.base_url;
  await upsertProvider(deps.ex, next);
  let extra = "";
  if (baseUrlChanged) {
    const rows = await runDiscovery(deps, p.id);
    extra = ` Discovery re-ran: ${rows.length} model(s).`;
  }
  return { reply: `Updated "${p.name}".${extra}` };
}

async function removeProvider(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const name = String(options.name ?? "");
  const removed = await deleteProvider(deps.ex, name);
  if (!removed) return { reply: `No provider named "${name}".` };
  await clearActiveIfProvider(deps.ex, removed.id);
  return { reply: `Removed provider "${removed.name}".` };
}

const EXAMPLE_PROMPT = "Reply with exactly: ok";

async function testProvider(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const name = String(options.name ?? "");
  const p = await getProvider(deps.ex, name);
  if (!p) return { reply: `No provider named "${name}".` };
  const apiKey = deps.env[p.key_env];
  if (!apiKey) return { reply: `Secret ${p.key_env} is not set in this environment. Set it with: doppler secrets set ${p.key_env}=...` };
  const cached = await deps.ex.query(`select model_id from ei_models_cache where provider_id = $1 order by model_id limit 1`, [p.id]);
  const active = await getActiveModel(deps.ex);
  const modelId =
    active && active.provider_id === p.id
      ? active.model_id
      : cached.rows.length
        ? String(cached.rows[0].model_id)
        : null;
  if (!modelId) {
    await deps.ex.query(
      `update ei_providers set last_tested_at = now(), last_test_ok = false, last_test_error = $1, updated_at = now() where id = $2`,
      ["no cached models", p.id],
    );
    return { reply: `No cached models for "${p.name}". Run /provider refresh first.` };
  }
  const model = buildLanguageModel({ provider_id: p.id, base_url: p.base_url, key_env: p.key_env, headers_json: p.headers_json, model_id: modelId }, deps.env);
  if (!model) return { reply: `Could not build a model client for "${p.name}".` };
  const started = Date.now();
  try {
    await generateText({ model, prompt: EXAMPLE_PROMPT, maxOutputTokens: 4 });
    const ms = Date.now() - started;
    await deps.ex.query(`update ei_providers set last_tested_at = now(), last_test_ok = true, last_test_error = null, updated_at = now() where id = $1`, [p.id]);
    return { reply: `OK for "${p.name}" via ${modelId} (${ms} ms).` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.ex.query(`update ei_providers set last_tested_at = now(), last_test_ok = false, last_test_error = $1, updated_at = now() where id = $2`, [msg, p.id]);
    return { reply: `"${p.name}" test failed: ${msg}` };
  }
}

async function refreshProvider(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const name = String(options.name ?? "");
  const p = await getProvider(deps.ex, name);
  if (!p) return { reply: `No provider named "${name}".` };
  const apiKey = deps.env[p.key_env];
  const result = await discoverModels({ baseUrl: p.base_url, name: p.name, apiKey, ex: deps.ex, fetchImpl: deps.fetchImpl, forceCatalog: true });
  await replaceModels(deps.ex, p.id, result.rows);
  const endpointNote = result.endpointError ? ` (endpoint: ${result.endpointError})` : "";
  return { reply: `Refreshed "${p.name}": ${result.rows.length} model(s).${endpointNote}` };
}

async function useModel(deps: CommandDeps, options: Record<string, string | boolean>): Promise<{ reply: string }> {
  const modelId = String(options.model ?? "");
  const rows = await listModelsForAutocomplete(deps.ex, modelId);
  const match = rows.find((r) => r.model_id === modelId);
  if (!match) return { reply: `Unknown model "${modelId}". Pick one from the autocomplete list.` };
  await setActiveModel(deps.ex, { provider_id: match.provider_id, model_id: modelId });
  return { reply: `Active model set to ${match.provider_id}/${modelId}. Applies from your next message.` };
}

export async function formatProviderList(ex: SqlExecutor, env: Record<string, string | undefined>): Promise<string> {
  const providers = await listProviders(ex);
  if (!providers.length) return "No providers configured. Use /provider add.";
  const active = await getActiveModel(ex);
  const lines: string[] = [];
  for (const p of providers) {
    const counts = await cacheCounts(ex, p.id);
    const total = counts.endpoint + counts.catalog;
    const key = env[p.key_env] ? "set" : "unset";
    const state = p.enabled ? "" : " [disabled]";
    const activeMark = active?.provider_id === p.id ? "  ⭐ ACTIVE" : "";
    lines.push(
      `\`${p.name}\`${state}: ${p.base_url} (key: ${key}, models: ${total}, endpoint: ${counts.endpoint}, catalog: ${counts.catalog})${activeMark}`,
    );
    if (active?.provider_id === p.id) lines.push(`  → ${active.model_id}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests and the typecheck**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/commands.test.ts
bunx tsc -p tsconfig.json
```
Expected: tests PASS (11 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: provider registry slash-command handlers"
```

---

### Task 9: Dynamic model resolver, in-process gateway boot, boot migration

**Files:**
- Modify: `packages/agent/lib/model.ts` (append `resolveStepModel`)
- Modify: `packages/agent/agent/agent.ts`
- Test: `packages/agent/tests/bootstrap.test.ts`

**Interfaces:**
- Consumes: Task 1 `shouldStartGateway`, `startGateway`; Task 3 `getExecutor`, `migrate`; Task 5 `getActiveModel`, `getProvider`, `ModelSource`, `buildLanguageModel`.
- Produces: the running system — resolver on `step.started`, gateway booted in-process, boot migration. `resolveStepModel(env)` exported from `lib/model.ts` for tests.

- [ ] **Step 1: Write the failing test**

Create `packages/agent/tests/bootstrap.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { runtimeIntakeUrl, shouldStartGateway } from "../lib/gateway/index";
import { resolveStepModel } from "../lib/model";

describe("gateway boot guard", () => {
  test("disabled by flag", () => {
    expect(shouldStartGateway({ EVE_GATEWAY_DISABLED: "1" })).toBe(false);
    expect(shouldStartGateway({ EVE_GATEWAY_DISABLED: "true" })).toBe(false);
    expect(shouldStartGateway({})).toBe(true);
  });
  test("intake URLs honor PORT and override", () => {
    expect(runtimeIntakeUrl({ PORT: "8080" }).intake).toBe("http://127.0.0.1:8080/intake");
    expect(runtimeIntakeUrl({ EVE_RUNTIME_URL: "http://host:9" }).interact).toBe("http://host:9/interact");
  });
});

describe("resolveStepModel", () => {
  test("returns null when no database is configured (graceful fallback)", async () => {
    expect(await resolveStepModel({})).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/bootstrap.test.ts
```
Expected: FAIL — `resolveStepModel` missing (the gateway tests pass after Task 2).

- [ ] **Step 3: Append `resolveStepModel` to `lib/model.ts`**

```ts
// Step-scoped resolver: a live LanguageModel returned from step.started;
// null degrades to the gateway fallback (never throws through).
import { getActiveModel, getProvider } from "./providers";
import { getExecutor } from "./db";

export async function resolveStepModel(env: Record<string, string | undefined>): Promise<LanguageModel | null> {
  const ex = getExecutor();
  if (!ex) return null;
  try {
    const active = await getActiveModel(ex);
    if (!active) return null;
    const provider = await getProvider(ex, active.provider_id);
    if (!provider || !provider.enabled) return null;
    return buildLanguageModel(
      {
        provider_id: provider.id,
        base_url: provider.base_url,
        key_env: provider.key_env,
        headers_json: provider.headers_json,
        model_id: active.model_id,
      },
      env,
    );
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Rewrite `packages/agent/agent/agent.ts`**

```ts
import { defineAgent, defineDynamic } from "eve";
import { getExecutor, migrate } from "../lib/db";
import { shouldStartGateway, startGateway } from "../lib/gateway/index";
import { resolveStepModel } from "../lib/model";

// Boot migration is idempotent and best-effort; the agent must boot without Postgres.
void (async () => {
  const ex = getExecutor();
  if (ex) await migrate(ex).catch((err) => console.error("ei migrate failed", err));
})();

// In-process Discord gateway (messages -> /intake, interactions -> /interact).
if (shouldStartGateway(process.env)) {
  // Surface fatal gateway errors so systemd restarts the whole service.
  startGateway().catch((err) => {
    console.error("gateway fatal", err);
    process.exit(1);
  });
}

export default defineAgent({
  model: defineDynamic({
    fallback: "anthropic/claude-sonnet-5",
    events: {
      "step.started": async () => resolveStepModel(process.env as Record<string, string | undefined>),
    },
  }),
  experimental: {
    workflow: {
      // Production: set WORKFLOW_TARGET_WORLD=@workflow/world-postgres (and
      // WORKFLOW_POSTGRES_URL). Defaults to the zero-DB local world.
      world:
        process.env.WORKFLOW_TARGET_WORLD === "@workflow/world-postgres"
          ? "@workflow/world-postgres"
          : "@workflow/world-local",
    },
  },
});
```

- [ ] **Step 5: Run tests, typecheck, and build**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/bootstrap.test.ts
bunx tsc -p tsconfig.json
bunx eve build
```
Expected: tests PASS (3), typecheck clean, `eve build` succeeds.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: step-scoped dynamic model resolver and in-process gateway boot"
```

---

### Task 10: Command registration script

**Files:**
- Create: `packages/agent/lib/registry.ts`
- Create: `scripts/register-commands.ts`
- Test: `packages/agent/tests/registry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildCommandDefinitions(): DiscordCommand[]`, `providerCommandCount(cmd)`, and a runnable `bun scripts/register-commands.ts [--dry-run|--list]`.

- [ ] **Step 1: Write the failing test**

Create `packages/agent/tests/registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildCommandDefinitions, providerCommandCount } from "../lib/registry";

describe("registry payload", () => {
  test("definitions contain one provider command with 7 subcommands", () => {
    const defs = buildCommandDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("provider");
    expect(providerCommandCount(defs[0])).toBe(7);
  });
  test("use subcommand has an autocomplete model option", () => {
    const defs = buildCommandDefinitions();
    const use = (defs[0].options as any[]).find((o: any) => o.name === "use");
    const model = use.options.find((o: any) => o.name === "model");
    expect(model.autocomplete).toBe(true);
    expect(model.required).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/registry.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/registry.ts`**

```ts
// Discord application command definitions for the provider registry.
export interface DiscordOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  options?: DiscordOption[];
}

export interface DiscordCommand {
  name: string;
  description: string;
  options: DiscordOption[];
}

// Discord option types: 3 STRING, 5 BOOLEAN, 1 SUB_COMMAND.
const O_STRING = 3;
const O_BOOL = 5;
const O_SUB = 1;

function nameOpt(required: boolean): DiscordOption {
  return { type: O_STRING, name: "name", description: "Provider name (must already exist)", required };
}

export function buildCommandDefinitions(): DiscordCommand[] {
  return [
    {
      name: "provider",
      description: "Manage BYOK OpenAI-compatible providers and models.",
      options: [
        { type: O_SUB, name: "add", description: "Register a new provider (opens a form).", options: [] },
        { type: O_SUB, name: "list", description: "List providers, cached models, and key status.", options: [] },
        {
          type: O_SUB,
          name: "edit",
          description: "Update a provider.",
          options: [
            nameOpt(true),
            { type: O_STRING, name: "base_url", description: "New OpenAI-compatible base URL" },
            { type: O_STRING, name: "key_env", description: "New Doppler secret name" },
            { type: O_BOOL, name: "enabled", description: "Enable or disable the provider" },
          ],
        },
        { type: O_SUB, name: "remove", description: "Remove a provider and its cached models.", options: [nameOpt(true)] },
        { type: O_SUB, name: "test", description: "Run a one-token completion against the provider.", options: [nameOpt(true)] },
        { type: O_SUB, name: "refresh", description: "Re-discover models from /v1/models + models.dev.", options: [nameOpt(true)] },
        {
          type: O_SUB,
          name: "use",
          description: "Set the active provider+model.",
          options: [
            { type: O_STRING, name: "model", description: "Model id from the cached catalog", required: true, autocomplete: true },
          ],
        },
      ],
    },
  ];
}

export function providerCommandCount(cmd: { options?: DiscordOption[] }): number {
  return (cmd.options ?? []).length;
}
```

- [ ] **Step 4: Implement `scripts/register-commands.ts`**

```ts
#!/usr/bin/env bun
// Register the provider slash commands. Run with Doppler env:
//   doppler run -- bun scripts/register-commands.ts [--dry-run|--list]
import { buildCommandDefinitions } from "../packages/agent/lib/registry";

const BASE = "https://discord.com/api/v10";

async function main(): Promise<number> {
  const dry = process.argv.includes("--dry-run");
  const list = process.argv.includes("--list");
  const token = process.env.DISCORD_BOT_TOKEN ?? "";
  const appId = process.env.DISCORD_APP_ID ?? "";
  const guildId = process.env.AGENT_OWNER_GUILD_ID ?? "";
  if (!token || !appId || !guildId) {
    console.error("DISCORD_BOT_TOKEN, DISCORD_APP_ID, AGENT_OWNER_GUILD_ID required (run under doppler run --).");
    return 2;
  }
  const url = `${BASE}/applications/${appId}/guilds/${guildId}/commands`;
  if (list) {
    const res = await fetch(url, { headers: { authorization: `Bot ${token}` } });
    console.log(JSON.stringify(await res.json(), null, 2));
    return 0;
  }
  if (dry) {
    console.log(JSON.stringify(buildCommandDefinitions(), null, 2));
    console.log(`\nWould PUT ${url}`);
    return 0;
  }
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(buildCommandDefinitions()),
  });
  if (!res.ok) {
    console.error("registration failed", res.status, await res.text());
    return 1;
  }
  console.log("commands registered:", JSON.stringify(await res.json(), null, 2));
  return 0;
}

process.exit(await main());
```

- [ ] **Step 5: Run tests and a dry-run**

```bash
cd /root/dev/projects/Ei/packages/agent
bun test tests/registry.test.ts
cd /root/dev/projects/Ei
bun scripts/register-commands.ts --dry-run
```
Expected: 2 tests PASS; dry-run prints the provider command JSON with 7 subcommands.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "feat: discord command registration script for provider commands"
```

---

### Task 11: Evals for the provider layer

**Files:**
- Create: `packages/agent/evals/evals.config.ts`
- Create: `packages/agent/evals/provider-switch-active.eval.ts`
- Create: `packages/agent/evals/provider-config-persists.eval.ts`
- Modify: `scripts/eval-ci.sh` (set `EVE_GATEWAY_DISABLED=1`)

**Interfaces:**
- Consumes: the running agent (resolver + fallback model). Uses `defineEval` from `eve/evals` and `includes` from `eve/evals/expect`.

- [ ] **Step 1: Author the evals**

`packages/agent/evals/evals.config.ts`:

```ts
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({});
```

`packages/agent/evals/provider-switch-active.eval.ts`:

```ts
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// Set EVAL_ACTIVE_MODEL_ID in the eval environment (Doppler) to the model the
// agent should report (default: the built-in fallback id).
export default defineEval({
  description: "The agent reports the model it is configured to use, matching the active provider/model selection.",
  async test(t) {
    await t.send("Which model id are you currently running on? Answer with the exact model id only.");
    t.succeeded();
    const expected = process.env.EVAL_ACTIVE_MODEL_ID ?? "claude-sonnet-5";
    t.check(t.reply, includes(expected));
  },
});
```

`packages/agent/evals/provider-config-persists.eval.ts`:

```ts
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// The active model selection stays stable across sessions (a proxy for the
// restart-persistence property, which a single eval run cannot trigger).
export default defineEval({
  description: "Active model selection persists across sessions.",
  async test(t) {
    const expected = process.env.EVAL_ACTIVE_MODEL_ID ?? "claude-sonnet-5";
    await t.send("Reply with the exact model id you are running on.");
    t.succeeded();
    t.check(t.reply, includes(expected));
    await t.newSession();
    await t.send("Same question: reply with the exact model id again.");
    t.succeeded();
    t.check(t.reply, includes(expected));
  },
});
```

Modify `packages/agent/..` -> the repo-root `scripts/eval-ci.sh` to export the gateway guard before invoking eve:

```bash
export EVE_GATEWAY_DISABLED=1
```

- [ ] **Step 2: Typecheck and discover**

```bash
cd /root/dev/projects/Ei/packages/agent
bunx tsc -p tsconfig.json
EVE_GATEWAY_DISABLED=1 bunx eve eval --help >/dev/null 2>&1 && echo "eval cli ok" || true
```
Expected: typecheck clean (evals/ is in tsconfig include). Full eval runs need real model keys (Doppler) and are part of the manual E2E.

- [ ] **Step 3: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "test: provider evals (switch/active, config persists) with gateway guard"
```

---

### Task 12: Docs, env cleanup, and deployment artifacts

**Files:**
- Delete: `packages/agent/.env.example`, `.env.example` (repo root)
- Modify: `.gitignore`, `packages/agent/.gitignore` (drop the `!.env.example` negation lines)
- Rewrite: `README.md`
- Create: `docs/ENV.md`

**Interfaces:**
- Consumes: everything prior.
- Produces: documentation a fresh operator can run from.

- [ ] **Step 1: Delete the example env files and un-negate gitignore**

```bash
rm -f /root/dev/projects/Ei/packages/agent/.env.example /root/dev/projects/Ei/.env.example
```

In `.gitignore` (root), delete these two lines: `!.env.example` and `!packages/**/.env.example`. In `packages/agent/.gitignore`, delete the `!.env.example` line. Keep the `node_modules`, `.env*`, `.eve`, `.output`, `dist` entries.

- [ ] **Step 2: Create `docs/ENV.md`**

```markdown
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
| `WORKFLOW_POSTGRES_URL` | Postgres connection string (workflow world + ei_* tables) |
| `PROVIDER_<NAME>_API_KEY` | One per BYOK provider; the name is stored in `ei_providers.key_env` |
| Whisper key (if used) | For the transcribe tool |

## Non-secret (also set in Doppler)

| Name | Values / notes |
| --- | --- |
| `PORT` | `3000` (default) |
| `WORKFLOW_TARGET_WORLD` | `@workflow/world-postgres` for the durable world |
| `WORKFLOW_POSTGRES_JOB_PREFIX` | `ei` |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | optional queue worker count |
| `EVE_RUNTIME_URL` | optional; defaults to loopback `http://127.0.0.1:${PORT}` |
| `EVE_GATEWAY_DISABLED` | `1` in eval/tests so no Discord connection is opened |
| `EVAL_ACTIVE_MODEL_ID` | eval expectation for the active model id |

## Doppler CLI cheat sheet

- `doppler setup --project ei`
- `doppler run -- bun run --cwd packages/agent dev`
- `doppler run -- bunx eve start`
- `doppler secrets set PROVIDER_GROQ_API_KEY=sk-...`
- `doppler secrets get WORKFLOW_POSTGRES_URL`
```

- [ ] **Step 3: Rewrite `README.md`**

Replace the README with a runbook covering, in order:
1. Architecture: one process — eve agent (Nitro, Postgres world, custom channels `/intake` + `/interact`) with the Discord gateway in-process (`lib/gateway`); config in `ei_*` tables; model resolution at `step.started` with gateway fallback; strict Doppler envs (`doppler.run`-wrapped everywhere).
2. Prerequisites: Node 24+, Bun 1.3.14, Doppler CLI, Postgres reachable via `WORKFLOW_POSTGRES_URL`.
3. Setup: `git clone <url>`, `bun install`; `doppler setup --project ei` (dev/prod configs); set the env values from `docs/ENV.md`; tables migrate automatically at boot.
4. Run: dev `doppler run -- bun run --cwd packages/agent dev`; production systemd unit:

```ini
# /etc/systemd/system/ei.service
[Service]
ExecStart=/usr/local/bin/doppler run -- bunx eve start
WorkingDirectory=/opt/ei/packages/agent
Restart=on-failure
```

5. Register commands: `doppler run -- bun scripts/register-commands.ts`.
6. Add a provider: `/provider add` → fill the modal → `doppler secrets set PROVIDER_<NAME>_API_KEY=...` → `/provider test <name>` → `/provider refresh <name>` → `/provider use <model>` (autocomplete picks from the live catalog).
7. Operations: `journalctl -u ei -f`; upgrade = pull + `bun install` + `bun run build` + restart the unit.
8. Testing: `bun test` in `packages/agent`; typecheck `bun run typecheck`; evals via `scripts/eval-ci.sh` (needs Doppler keys; sets `EVE_GATEWAY_DISABLED`).
9. Security: keys referenced by name only, ephemeral command replies, owner gates (secret header + Discord id), `allowed_mentions: { parse: [] }`.
10. Scaling/future: `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` for queue parallelism; gateway re-extraction via `EVE_RUNTIME_URL`.

- [ ] **Step 4: Verify no secrets or stale references**

```bash
cd /root/dev/projects/Ei
rg -n "docker-compose|packages/connector|dev:connector|\.env\.example" README.md docs package.json packages --glob '!node_modules/**' || true
rg -in "AI_GATEWAY|sk-[A-Za-z0-9]{10,}" --glob '!node_modules/**' --glob '!.eve/**' --glob '!.output/**' . || true
git status --short
```
Expected: no docker/connector/env.example references in README/docs/package.json; no secret-looking strings tracked.

- [ ] **Step 5: Full verification pass**

```bash
cd /root/dev/projects/Ei
bun install
bun run typecheck
cd packages/agent && bun test
```
Expected: install clean, both package typechecks clean, all unit tests pass.

- [ ] **Step 6: Commit**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "docs: single-service runbook, doppler env reference; remove example env files"
```

---

### Task 13: End-to-end verification (manual / optional)

**Files:** none (verification only).

- [ ] **Step 1: Boot with local state**

```bash
cd /root/dev/projects/Ei/packages/agent
bunx eve build
EVE_GATEWAY_DISABLED=1 bunx eve start
```
Expected: server boots; `/eve/v1/health` returns 200; `/intake` and `/interact` return 403 without the secret header.

- [ ] **Step 2: Live Discord + Doppler (requires real keys; README runbook)**

Follow README steps 5–6 with a real bot and Doppler project: register commands, add a provider, set its secret, test, refresh, use; confirm the reply model changes. This is the acceptance E2E and needs the user's credentials — not runnable in this sandbox.

- [ ] **Step 3: Commit any verification fixes**

```bash
cd /root/dev/projects/Ei
git add -A
git commit -m "fix: verification fixes from boot smoke"
```
