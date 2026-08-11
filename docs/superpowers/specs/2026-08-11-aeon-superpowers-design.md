# Aeon Superpowers (Soul, Self-healing, Lineage) — Design

Status: approved by user on 2026-08-11 (4 design questionnaires)
Author: brainstorm session (user + Droid)
Repo: /root/dev/projects/Ei

## 1. Vision and scope

The agent can already act on the user's personal ops (Composio),
persist knowledge (innernet), and run scheduled jobs (one dispatcher +
`ei_schedules`/`ei_schedule_runs`). This slice inherits three concepts from
the [Aeon framework](https://github.com/aeonfun/aeon) that make it
self-improving rather than static:

1. **Soul (voice layer)** — a persistent, always-in-context identity and
   style, shaped as a `soul/` directory in Aeon. In Ei this becomes the
   `agent/instructions/` directory: two small authored files that load into
   every turn alongside the existing flat `instructions.md`.
2. **Self-healing loop** — Aeon detects, files an issue, repairs, and notifies
   (skill-health). Per user policy, Ei's loop is **detect + propose only**:
   it monitors schedule health, opens/resolves durable issue rows, and posts a
   proposal directive to the affected thread; the session agent drafts the
   concrete options and **the user approves every repair** before the existing
   `schedule_update` tool applies it. No auto-changes.
3. **Autoresearch lineage** — Aeon's lineage slots
   (`<!-- autoresearch: variation X -->`) generate prompt-improvement
   variations. In Ei this targets **schedule prompts only**: weekly, the worst
   healthy schedule is picked, a directive asks the in-session agent to draft
   four tagged variations (A/B/C/D), the user picks one, and the choice is
   applied via the existing `schedule_update` tool with a lineage marker
   recorded in the schedule's `tags`.

All three layers are delivered in order **soul → healing → lineage** (each its
own commit), are built on already-verified eve primitives (instructions
directory form; schedule → session directive injection via `to(discord,…)`
without a `scheduleRunId`), and reuse existing tables/tools wherever possible
(`ei_config` for gates; `schedule_update` for all application).

**Out of scope:** code/tool lineage (schedule prompts only), auto-applied
repairs (detect + propose only), headless LLM calls inside schedule handlers
(the session model authors everything), an `ei_issues` admin surface beyond the
agent answering from it, changes to the existing 3-consecutive-failure
auto-pause brake, and non-Discord delivery.

## 2. Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Soul placement | `agent/instructions/` **directory** (verified in eve 0.31.3: multiple `.md` loaded sorted by name, flat `instructions.md` coexists and loads first) | Always-in-context by construction; no runtime file reads, no build step. User-selected over a runtime `soul/` read. |
| Soul files | `01-voice.md` + `02-style.md` (numeric prefix controls load order) | Keep the existing flat `instructions.md` (identity/communication/capture/query/boundaries/compliance/scheduled jobs) unmodified; soul layers on top. |
| Healing mode | **Detect + propose only** — the loop opens/resolves issue rows and posts directives; all repairs go through the session agent + `schedule_update` after explicit user approval | User-selected ("no auto-changes, you approve each repair"). |
| Healing mechanics | **Directive schedules + in-session drafting** (Approach A): a daily `health` schedule computes pure assessment, injects an un-addressed directive into each affected thread; the session model drafts the proposal | Schedules stay thin; LLM authoring happens where a model exists; detection is pure and unit-testable. |
| Issue store | New **`ei_issues`** table (migration + tests) | User-selected over `ei_config` JSONB — queryable history, joins to `ei_schedules`. |
| Dedup gate | `ei_config` key `health:last_report` (JSONB hash + `at`), mirrored on Aeon's state-hash gate | A steady-state issue is not re-nagged every run. |
| Auto-pause brake | **Keep** the existing dispatcher auto-pause (3 consecutive delivery failures → `enabled=false`) as a safety brake; the healing loop proposes resume/rewrite afterward | User-selected. The brake is mechanical protection, not a repair; healing owns the proposal. |
| Lineage target | **Schedule prompts only**, selected worst-health-first | User-selected scope. |
| Lineage mechanics | Weekly `lineage` schedule picks a target and injects a directive; the model drafts A/B/C/D variations and a confidence line; user picks; model applies via `schedule_update` (approval flows as normal) | Same in-session-drafting rationale as healing; application reuses the existing tool, no new mutation surface. |
| Lineage marker | `tags` jsonb on the schedule gains `{lineage: {generation, variation, applied_at}}` | Existing column; no migration. |
| Lineage gate | `ei_config` key `lineage:pending` (schedule id, `at`, TTL) | Avoids re-targeting the same schedule while a proposal awaits the user / evades. |
| Cadence | `health` daily `0 9 * * *`; `lineage` weekly `0 11 * * 1` (UTC, matching `ei_schedules` timezone convention) | Daily catch-up; weekly improvement — both cheap, both silent when there is nothing to say. |
| Agent guidance | New `# Self-healing and evolution` section in `instructions.md` | The session model must know how to respond to directive messages (draft options, never apply without a pick). |

## 3. Architecture

```
agent/
├── instructions.md            # existing flat file (loads first, unchanged)
├── instructions/
│   ├── 01-voice.md            # NEW soul voice (always-in-context)
│   └── 02-style.md            # NEW soul style  (always-in-context)
├── schedules/
│   ├── dispatcher.ts          # existing 1-minute dispatcher (unchanged)
│   ├── health.ts              # NEW daily 0 9 * * * — assess → reconcile → directive
│   └── lineage.ts             # NEW weekly 0 11 * * 1 — pick target → directive
├── lib/
│   ├── gate.ts                # NEW ei_config readGate/writeGate + PENDING_TTL_MS
│   ├── issues.ts              # NEW ei_issues adapter (findOpen/open/resolve/list)
│   ├── health.ts              # NEW pure assessment (per-schedule classification)
│   └── lineage.ts             # NEW pure target selection + directive builder
```

All three schedules are authored `defineSchedule` files like `dispatcher.ts`;
none are user-editable `ei_schedules` rows. Health/lineage handlers never call
LLM APIs — they compute (pure libs), open/resolve rows, and inject a plain
directive message into the target thread; the session agent does the writing.

### 3.1 Soul layer (`instructions/01-voice.md`, `02-style.md`)

- **Load contract (verified in eve source):** `discoverInstructionsSource`
  pushes the flat `instructions.md` first (`n.unshift(a.source)`), then the
  directory's files in `readSortedDirectoryEntries` order
  (`localeCompare`). The `01-`/`02-` prefixes make the order explicit
  (flat core → voice → style).
- `01-voice.md` — identity/worldview/tone: who the agent is, what it values
  (warmth, plainspokenness, lead-with-the-answer), how it handles ambiguity
  and tasks it cannot complete. Drafted to be consistent with — not
  contradictory to — the existing `# Identity` heading.
- `02-style.md` — concrete writing rules: sentence/paragraph length, markdown
  discipline, emoji policy (already: none unless the user starts),
  **banned-phrase/anti-pattern list** (e.g. "As an AI…", "certainly!",
  hedging stacks), "answer first, detail on request", "absorb, don't quote".
- Together ~60–90 lines of new instructions, injected every turn. No runtime
  file IO, no new deps, no build changes. `eve build` must show 3 instruction
  sources (flat + 2) with zero diagnostics.

### 3.2 Self-healing loop

**Data model** (new `ei_issues`, appended to `MIGRATE_SQL` in `lib/db.ts`):

```sql
create table if not exists ei_issues (
  id          text primary key,
  schedule_id text not null references ei_schedules(id) on delete cascade,
  kind        text not null,      -- 'consecutive-failures' | 'degraded' | 'stale'
  severity    text not null,      -- 'critical' | 'degraded' | 'warning'
  status      text not null default 'open',   -- 'open' | 'resolved'
  root_cause  text not null,      -- normalized error signature (first 200 chars, '%'→'' dedup hack)
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text                -- 'auto' when reconcile resolves a recovered schedule
);
```

**`lib/issues.ts`** (pure adapter, pg-mem tested, mirrors `schedule-store.ts`
style):

- `findOpenIssue(ex, scheduleId, kind, rootCause?)` — dedup probe.
- `openIssue(ex, {scheduleId, kind, severity, rootCause, detail})` — insert
  if absent; if an open issue exists for the same `schedule_id`+`kind`+`root_cause`,
  **coalesce**: overwrite `severity`/`detail`, bump `updated_at` (so the
  last-report gate sees a change and re-notifies on worsening).
- `resolveIssue(ex, issueId, {by: "auto"})` — set `status='resolved'`,
  `resolved_at`, `resolved_by`.
- `listIssues(ex, {status?, now?})` — recent open issues, newest first.

**`lib/health.ts`** (pure, pg-mem tested):

- `assessSchedules(ex, {now})` → per enabled schedule:
  - `consecutiveFailures` — newest runs query (same shape as the dispatcher's
    auto-pause probe: `select … order by started_at desc limit N`, count
    trailing `failed`).
  - `successRate` over the last 10 runs.
  - `lastError` (trimmed to 200 chars), `daysSinceLastSuccess`,
    `daysSinceUpdated`, `hasRunAny`.
  - Classification (any-of, worst wins): `critical`
    (`consecutiveFailures ≥ 3`; in practice the dispatcher auto-pause usually
    disables such schedules first, so this rule catches re-enabled schedules
    and runs that failed when the brake was off), `degraded`
    (`successRate < 0.6` over ≥ 5 runs), `stale` (`daysSinceUpdated ≥ 14`),
    else `healthy`; `no-data` when no runs at all.
  - Issue map: `critical → {kind: 'consecutive-failures', severity: 'critical'}`,
    `degraded → {kind: 'degraded', severity: 'degraded'}`,
    `stale → {kind: 'stale', severity: 'warning'}`; `healthy`/`no-data`
    resolve any open issue for that schedule.
- `reconcileIssues(ex, assessments, {now})` — `openIssue` for each
  non-`healthy`/`no-data` schedule; `resolveIssue` when a schedule recovered
  (this is the only auto-mutation, and it only resolves — never repairs).
- `buildHealthDirective(findings)` → the injected message text
  (see §4 flow).

**`ei_config` gate helpers** (shared by both schedules, `lib/gate.ts`):

- `readGate(ex, key)` → JSONB value or `null`; `writeGate(ex, key, value)` →
  upsert. Backed by the existing `ei_config` table (`key text primary key`).
- Keys used: `health:last_report` (`{hash, at}`), `lineage:pending`
  (`{scheduleId, at}`).
- `PENDING_TTL_MS = 7 days` — gate expiry for `lineage:pending` and the
  lineage-`tags` cooldown.

**`agent/schedules/health.ts`** (`0 9 * * *`):

```ts
export default defineSchedule({
  cron: "0 9 * * *",
  async run({ to, waitUntil, appAuth }) {
    const ex = getExecutor();
    if (!ex) return; // Postgres absent: nothing to assess; agent still boots.
    await waitUntil(
      (async () => {
        const before = await readGate(ex, "health:last_report");
        const assessments = await assessSchedules(ex, { now: new Date() });
        const findings = await reconcileIssues(ex, assessments, { now: new Date() });
        const now = new Date();
        const hash = stableReportHash(assessments);      // stable hash of current severities
        if (hash === before?.hash) return;               // steady state: stay silent
        // Store the gate only AFTER the sends (see §5): a failed send then
        // re-fires on the next daily tick because the gate still differs.
        for (const f of findings.newOrChanged) {
          // Inject a *directive* into the affected schedule's own thread
          // (no scheduleRunId → plain message, no run row).
          await to(discord, {
            guildId: f.guild_id, channelId: f.dm_channel_id,
            threadId: f.dm_thread_id ?? undefined,
          }).send(buildHealthDirective(f), { auth: appAuth });
        }
        await writeGate(ex, "health:last_report", { hash, at: now.toISOString() });
      })(),
    );
  },
});
```

- `findings.newOrChanged` = schedules with a new open issue or a coalesced
  (changed) one — i.e. anything the last-report gate didn't already cover.
- Directive lands in **the affected schedule's own DM thread** — the same
  thread where that job's failures are visible — so context is local.
- `waitUntil` keeps the cron task alive until assessment + sends settle, same
  as the dispatcher.

**`# Self-healing and evolution`** (in `instructions.md`) teaches the session
model the contract for a directive message:
- A directive names a schedule, its symptom (N consecutive failures / poor
  success rate / stale), and its current prompt.
- Draft **2–3 concrete options** (e.g. pause, rewrite prompt, adjust
  cadence, delete) with a one-line rationale each and a recommendation.
- **Never** call `schedule_update`/`schedule_delete` until the user picks an
  option in-thread; then apply exactly the picked change and confirm.
- When asked "what's broken?" or "any issues?", answer from the `ei_issues`
  state (via a read-only query through the existing `schedule_list` /
  guidance — no new tool needed).

### 3.3 Autoresearch lineage (schedule prompts only)

**`lib/lineage.ts`** (pure, pg-mem tested):

- `selectLineageTarget(ex, {now, pending})` → among **enabled** schedules
  with a non-empty `prompt`, prefer worst health (critical > degraded > stale
  > healthy), then least-recently-updated; exclude schedules with a live
  `lineage:pending` gate, and exclude schedules whose latest `tags` entry has
  `lineage` applied within the last 7 days. Return `null` when nothing
  qualifies (weekly silent no-op).
- `buildLineageDirective(target)` → the injected message text asking for
  **exactly four variations**, tagged for lineage tracking:

  > Lineage target: `<name>` (`<id>`), health `<status>`.
  > Current prompt: `<prompt>`.
  > Draft 4 variations of this schedule's prompt, each labeled:
  > **A — better inputs/trigger**, **B — sharper output/format**,
  > **C — more robust (fallbacks, error handling)**,
  > **D — rethink the approach**.
  > End with a one-line confidence ranking. Make no changes — wait for my pick.

**`agent/schedules/lineage.ts`** (`0 11 * * 1`):

```ts
export default defineSchedule({
  cron: "0 11 * * 1",
  async run({ to, waitUntil, appAuth }) {
    const ex = getExecutor();
    if (!ex) return;
    await waitUntil(
      (async () => {
        const pending = await readGate(ex, "lineage:pending");
        if (pending && Date.now() - new Date(pending.at).getTime() < PENDING_TTL_MS) return;
        const target = await selectLineageTarget(ex, { now: new Date(), pending });
        if (!target) return; // nothing to improve: stay silent
        await writeGate(ex, "lineage:pending", { scheduleId: target.id, at: new Date().toISOString() });
        await to(discord, { guildId: target.guild_id, channelId: target.dm_channel_id,
                            threadId: target.dm_thread_id ?? undefined })
             .send(buildLineageDirective(target), { auth: appAuth });
      })(),
    );
  },
});
```

**Applying the pick (existing surface):** the user replies in-thread
("B is best", "use A"); the session model calls `schedule_update(id, {prompt:
<chosen>})` (normal `always()` approval) and appends to the schedule's `tags`
jsonb: `{lineage: {generation: n, variation: "B", applied_at: iso}}`. Only the
prompt field changes — cadence, target, and identity are untouched by design.

**Scope guard (hard):** lineage may propose and apply changes to **schedule
prompts only**. It never touches `instructions/`, tool code, or schedules'
identity. The directive text above states this constraint, and the
`selectLineageTarget` shape enforces it structurally (only `prompt` is
offered for replacement).

## 4. Data flow (end to end)

1. **Daily 09:00 UTC**: `health.ts` reads the last-report gate, runs
   `assessSchedules`, `reconcileIssues` opens/coalesces/resolves rows, computes
   the new state hash. Steady state → returns silently.
2. On a state **change** (new or worsened issue), the health schedule injects
   `buildHealthDirective(f)` into that schedule's thread. The session agent
   (now holding both the directive and the `# Self-healing and evolution`
   section in context) drafts options and replies.
3. The user picks ("pause it" / "rewrite the prompt to …"). The agent applies
   via `schedule_update` (approval flow) and confirms. The issue row stays
   `open` until the next assessment sees the schedule recovered, then
   `resolveIssue` marks it `resolved` (auto — detection, not repair).
4. **Weekly Mon 11:00 UTC**: `lineage.ts` targets the worst-health eligible
   schedule (pending gate absent or expired), writes `lineage:pending`,
   injects the four-variation directive. The agent drafts A/B/C/D + ranking;
   the user picks; the agent applies via `schedule_update` and tags the
   lineage marker. The pending gate expires via `PENDING_TTL_MS` (7 days), so
   a target isn't re-picked while a proposal sits unanswered, and a fresh
   round starts after the next weekly run.
5. No Postgres → `health`/`lineage` return early; the agent boots and answers
   as before.

## 5. Error handling

- **Postgres absent:** `getExecutor()` returns `null`; both schedules return
  early (same degradation as the dispatcher).
- **Directive send failure** (Discord down): thrown inside `waitUntil` — the
  run fails; the gate hash was already written, so a one-off failed send
  would suppress the notification. Mitigation: write the gate only **after**
  the sends, so a failed send re-fires next daily tick (assessment is
  idempotent; issues coalesce).
- **Duplicate/overlapping runs:** near-impossible at daily/weekly cadence;
  `waitUntil` + coalescing keeps both idempotent. The dispatcher's atomic
  lease is untouched.
- **Assessment query errors:** surface as thrown in the schedule run (visible
  in schedule-run logs), no state mutation before the send step.
- **Auto-pause interplay:** the dispatcher brake (3 consecutive failures →
  `enabled=false`) remains. A paused schedule is not assessed (disabled rows
  are skipped), and the **healing loop's proposal is the documented path to
  resume/rewrite it** (the user says "resume it", agent re-enables via
  `schedule_update`).

## 6. Testing

- **Unit (bun test, agent package, pg-mem fixtures — repo convention):**
  - `tests/issues.test.ts` — open/dedup/coalesce/resolve lifecycle; FK
    cascade on schedule delete; jsonb `detail` round-trip (pg-mem jsonb
    normalization via the existing `jsonValue` helper).
  - `tests/health.test.ts` — seeded `ei_schedules` + `ei_schedule_runs`:
    classification per rule (consecutive failures / success rate / stale /
    healthy / no-data), reconcile opens-new + resolves-recovered, gate hash
    write, directive text contains name + symptom + options contract.
  - `tests/lineage.test.ts` — target selection (worst health wins; pending
    gate excludes; 7-day lineage cooldown; null when nothing qualifies),
    directive text contains exactly the A/B/C/D labels.
- **Discovery/build:** `bun run build:agent` → `eve build` exits clean and
  shows **3 schedules** (dispatcher, health, lineage) and **3 instruction
  sources** (`instructions.md`, `01-voice.md`, `02-style.md`) with no
  diagnostics.
- **Regression:** `bun run typecheck` + `bun test` fully green (existing 90
  pass). `bootstrap.test.ts` unaffected (it asserts gateway/model resolution,
  not instruction content).
- **Live E2E (user side):** trigger `schedule_trigger` on a failing schedule
  enough times to produce ≥ 3 consecutive failures with the auto-pause brake
  active, re-enable it, and confirm the next 09:00 health run posts a
  directive and a user pick applies via `schedule_update`; confirm the weekly
  lineage directive appears for a target schedule.

## 7. Docs

- `README.md`: "Self-healing & evolution" section — what the daily/weekly
  loops do, the detect + propose only policy, and how to inspect issues
  ("what's broken?").
- `docs/ENV.md`: unchanged (no new environment variables).
- `lib/db.ts` `MIGRATE_SQL`: gains `ei_issues` (idempotent, matching the
  existing migration style; `migrate()` is already called at boot).

## 8. Success criteria

1. The agent boots with all 3 schedules and 3 instruction sources discoverable
   (`eve build` clean); zero behavior change with no Postgres.
2. "What's broken?" → the agent answers from the healing loop's issue state
   and proposes fixes; a user pick applies via `schedule_update` and the
   auto-pause brake still holds as a safety ceiling.
3. A schedule that recovers sees its `ei_issues` row transition
   open → resolved automatically; a steady-state issue is not re-nagged daily.
4. Weekly, the lineage loop proposes A/B/C/D variations for the worst-health
   schedule prompt; a pick updates the prompt only, with a `lineage` tag
   recorded; no non-prompt field ever changes through lineage.
5. Voice + style instructions are present in every session without extra
   runtime work, and the agent's replies observably match the style rules
   (concise, no banned phrases) — no contradictions with the flat
   `instructions.md`.
