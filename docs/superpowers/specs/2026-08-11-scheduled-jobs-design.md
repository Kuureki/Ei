# Scheduled Jobs — Design

Status: approved by user on 2026-08-11
Author: brainstorm session (user + Droid)
Repo: /root/dev/projects/Ei

## 1. Vision and scope

The agent can now act on the user's personal ops (Calendar, Gmail, Todoist via
Composio) and persist knowledge. This slice adds the missing proactive layer:
**scheduled jobs**. The user tells the agent in plain Discord

> "remind me tomorrow at 9 to call the dentist"
> "digest my calendar every weekday at 8am"
> "fetch my Gmail labels each morning"

and the agent records the job, runs it on schedule, delivers the outcome into a
Discord DM, and can always answer "what did the morning job do?" from stored
run logs.

This covers the deferred "scheduled / autonomous jobs" from both prior specs
(no scheduled jobs shipped in slice 1; "no scheduled jobs driving Composio" in
slice 2).

**Out of scope:** meeting transcription, coding-in-repo work, web/chat UI
beyond Discord, multi-user, non-Discord delivery targets, per-job owner
separation (single-owner agent), and a public admin surface (the tool layer
below is the only surface).

## 2. Locked decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Surface | **Agent tools only** — no new Discord slash commands | User-selected ("we will expose tools to the agent"). The model handles "remind me…" in plain Discord; the tool surface (`schedule_create` etc.) is the entire management surface. |
| Delivery | **Proactive Discord DM via a `receive()` hook on the existing custom `discord.ts` channel** | eve ships a first-party `discordChannel`, but it is HTTP-interactions-based (needs `DISCORD_PUBLIC_KEY` + a public inbound route) and conflicts with this repo's outbound-gateway, no-public-inbound constraint. The existing custom channel already owns outbound Discord delivery (`deliverToDiscord`); adding `receive` makes schedule handoff framework-first-class with zero new Discord REST code. |
| Runtime | One dispatcher schedule (`agent/schedules/dispatcher.ts`, `cron: "* * * * *"`) + app-managed rows in Postgres | eve's [dynamic-scheduling pattern](https://eve.dev/docs/patterns/dynamic-scheduling): authored schedules are static files with static crons; arbitrary user cadences require app-managed rows and an atomic-leasing dispatcher. |
| Job store | New tables `ei_schedules` + `ei_schedule_runs` in the existing Postgres (`WORKFLOW_POSTGRES_URL`), bootstrapped by the existing idempotent `lib/migrate.ts` | Matches repo convention (own `ei_*` tables via `lib/db.ts` `MIGRATE_SQL`). |
| Run logging | A run row per dispatch; output = trimmed final assistant message | "Ask the agent about jobs and last runs" (`schedule_runs`) plus status/error/timestamps. Queryable, restart-proof (run id rides the continuation token). |
| Delivery mode | **Prompt mode** for user-described jobs (the schedule stores a prompt; the dispatcher sends it to the DM session; the agent does the work; the DM reply is the deliverable) | Matches the user's primary choice (proactive summaries/reminders) and needs no handler per job. |
| Cadence | `everyMinutes` \| `dailyAt` \| `weeklyOn` \| `monthlyOn` \| raw `cron` (UTC) — computed in `lib/schedule-admin.ts` | Covers "every N min", "at HH:MM timezone", "weekdays 9am", "3rd of month" and arbitrary cron. |
| Approval | `always()` on `schedule_create`/`schedule_update`/`schedule_delete`/`schedule_trigger`; reads free | Creates recurring agent work (cost + side effects) — eve's approval flow confirms. |
| Timezone | Per-job `timezone` (default UTC), `Intl`-based | Powered by the calendar/task features; DST-adjacent correctness via `Intl`. |

## 3. Architecture

```
agent/
├── channels/discord.ts          # + receive() hook for proactive schedule delivery
├── schedules/dispatcher.ts      # the one true schedule: * * * * *
├── lib/schedule-store.ts        # ei_schedules + ei_schedule_runs adapter (atomic lease)
├── lib/schedule-admin.ts        # cadence/timezone math, validation, renderers (pure)
├── tools/schedule_create.ts     # agent-callable, approval: always()
├── tools/schedule_list.ts       # read
├── tools/schedule_update.ts     # approval: always()
├── tools/schedule_delete.ts     # approval: always()
├── tools/schedule_runs.ts       # read: "what did X do?"
├── tools/schedule_trigger.ts    # run now, out of band; approval: always()
└── instructions.md              # scheduling guidance (hosted in agent/instructions.md)
```

Only `schedules/dispatcher.ts` is an authored schedule. Everything else is a
tool file (discovered by filename per eve convention, no registration) or a
channel hook.

### 3.1 The dispatcher (`agent/schedules/dispatcher.ts`)

```ts
import { defineSchedule } from "eve/schedules";
import discord from "../channels/discord";
import { claimDue } from "../lib/schedule-store";

export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil, appAuth }) {
    waitUntil(
      (async () => {
        const jobs = await claimDue({ now: new Date(), limit: 25, leaseForMs: 5 * 60_000 });
        await Promise.all(
          jobs.map(async (job) => {
            try {
              const run = await createRun(job); // ei_schedule_runs row, status 'running'
              await to(discord, {
                guildId: job.guild_id,
                channelId: job.dm_channel_id,
                threadId: job.dm_thread_id,
                scheduleRunId: run.id,
              }).send(
                [job.prompt, "This is a scheduled job. Report done (or ask for help) concisely."].join("\n\n"),
                { auth: appAuth },
              );
            } catch (error) {
              await failRun(job, error);
            }
          }),
        );
      })(),
    );
  },
});
```

- `claimDue` atomically leases due rows so overlapping minute ticks never
  double-claim; per job it creates the `ei_schedule_runs` row (status
  `running`) before handoff. Each job's prompt goes through the
  existing Discord channel `receive()`
  hook, which starts a normal durable session whose output is delivered back
  to the job's stored DM (`message.completed` → `deliverToDiscord`, unchanged).
- `waitUntil` keeps the cron task alive until claim + handoff settle.
- `appAuth` is eve's app principal (`eve:app`), attributing the proactive
  session to the agent.

### 3.2 Delivery via `receive()` on the existing channel

`agent/channels/discord.ts` gains a `receive(input, ctx)` hook:

```ts
receive(input, ctx) {
  const address = encodeToken(input.target);
  return ctx.from(address).send(input.message, { auth: input.auth });
}
```

- `input.target` is `{ guildId, channelId, threadId? }` — the job's stored
  Discord address, from `InferReceiveTarget` of `encodeToken` shape.
- This replaces the current `from(address).send(…)` used by `/intake` (no
  behavior change for inbound) and adds proactive capability.
- The existing `message.completed` handler already calls
  `deliverToDiscord(addr, message)`; no new outbound code.

### 3.3 Run logging (restart-proof)

`schedules` continue across restarts because:

- The **continuation token** in `packages/shared/src/discord-util.ts`
  (`encodeToken`/`decodeToken`, currently `guild:channel[:thread]`) gains an
  optional `scheduleRunId?: string` field, appended as a fourth segment.
- The dispatcher passes it as the `target` (`{ guildId, channelId, threadId,
  scheduleRunId }`); `receive` forwards it; `discord.ts` event handlers read
  `scheduleRunId` from the decoded token and write the run row:

| Event | Run-row write |
| --- | --- |
| `turn.started` (first time) | `status='running'`, `started_at=now` |
| `message.completed` | `output = trimmed final assistant message`, `status='succeeded'`, `finished_at=now` |
| `session.failed` / `turn.failed` | `status='failed'`, `error` captured, `finished_at=now` |

### 3.4 Tool surface

All tools enforce the single-owner gate via `ctx.session.auth` (the same
`principalType === "user"` check used by the admin surfaces). Mutations use
`always()` approval from `eve/tools/approval`.

| Tool | Input | Approval | Behavior |
| --- | --- | --- | --- |
| `schedule_create` | `name`, `prompt`, cadence (`everyMinutes` \| `dailyAt` + `time` \| `weeklyOn` + `days` + `time` \| `monthlyOn` + `dayOfMonth` + `time` \| `cron`), `timezone` (default UTC), optional `firstRunAt` ISO+offset, `tags` | `always()` | Insert row, compute `next_run_at` from cadence+timezone; resolve DM/thread from the requesting session's continuation; reply with id + next run |
| `schedule_list` | — | none | List enabled+disabled jobs (id, name, cadence, next run, last status) |
| `schedule_update` | `id`, optional `name`/`prompt`/cadence/`timezone`/`enabled`/`tags` | `always()` | Recompute `next_run_at` on cadence/timezone change; toggle `enabled` |
| `schedule_delete` | `id` | `always()` | Delete row (cascade runs); reply confirmation |
| `schedule_runs` | `id`, optional `limit` (default 3, cap 20) | none | Last N runs: status, started/finished, output (trimmed) |
| `schedule_trigger` | `id` | `always()` | Force `next_run_at=now`; dispatcher picks it up ≤ 60 s; reply "will run within a minute" |

`agent/instructions.md` gains a **Scheduled jobs** section: confirm cadence +
timezone + target before creating; when asked "what did X do?", use
`schedule_runs`; when asked to pause/resume, use `schedule_update`.

## 4. Data model

```sql
create table if not exists ei_schedules (
  id              text primary key,           -- slug or base58 id chosen at creation
  name            text not null,              -- user-facing job name
  prompt          text not null,              -- the job body
  cadence         text not null,              -- 'every_minutes'|'daily_at'|'weekly_on'|'monthly_on'|'cron'
  every_minutes   int,                        -- for 'every_minutes'
  cron            text,                       -- for 'cron' (5-field, UTC)
  timezone        text not null default 'UTC',
  enabled         boolean not null default true,
  next_run_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_run_at     timestamptz,
  last_run_status text,                       -- 'running'|'succeeded'|'failed'|'skipped'|null
  last_run_output text,
  run_count       bigint not null default 0,
  locked_until    timestamptz,                -- atomic claim window
  locked_by       text,
  owner_discord_id text not null,
  guild_id        text not null,              -- resolved once at creation (encodeToken needs it)
  dm_channel_id   text not null,              -- resolved once at creation
  dm_thread_id    text,
  tags            jsonb default '[]'::jsonb,
  created_by      text                        -- owner principal id
);

create table if not exists ei_schedule_runs (
  id          text primary key,
  schedule_id text not null references ei_schedules(id) on delete cascade,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null,                  -- 'running'|'succeeded'|'failed'|'skipped'
  output      text,
  error       text,
  session_id  text                            -- eve session id of the dispatch, when available
);
```

- `next_run_at` computation lives in `lib/schedule-admin.ts` (pure, tz-aware
  via `Intl`): "every 30 minutes", "daily at 08:30 America/New_York", "weekdays
  9am", "monthly on the 3rd", or a raw 5-field cron (UTC). Weekday semantics:
  `weeklyOn` accepts 0-6 (0=Sunday); `monthlyOn` accepts 1-31 (days beyond
  month-end clamp to the last day, documented). `dailyAt` time is
  HH:MM (24 h) in the job timezone.
- `claimDue` uses `FOR UPDATE SKIP LOCKED` semantics expressed as
  `UPDATE ... WHERE next_run_at <= now() AND enabled AND (locked_until IS NULL
  OR locked_until < now()) ... RETURNING` to atomically lease rows.

## 5. Delivery flow (end to end)

1. User: "remind me tomorrow at 9am to call the dentist" in a DM.
2. Agent calls `schedule_create` (approval flow confirms); the tool resolves
   the DM/thread from the requesting session's continuation, computes
   `next_run_at`, inserts the row, replies with id + next run.
3. On the next dispatcher tick (≤ 60 s), `claimDue` leases the row and hands
   the prompt to `receive()` on the discord channel with `appAuth`; a durable
   session starts; `turn.started` writes a `running` run row (`scheduleRunId`
   rides the continuation token).
4. The agent answers (calls Todoist/the calendar via composio if needed);
   `message.completed` delivers the reply to the DM via `deliverToDiscord` and
   writes `succeeded` + trimmed output; the dispatcher computes the next
   `next_run_at` from cadence + timezone.
5. Later: "what did the morning job do?" → `schedule_runs` answers with the
   last runs' status + output.

## 6. Error handling

- **Store failures**: `claimDue`/row writes throw → per-job `catch` writes a
  `failed` run row and applies exponential backoff (next attempt in
  `min(2^n * 60, 24h)` s).
- **Delivery failures** (e.g. `to(...).send` throws): run row `failed` + DM
  error notice sent to the job's channel when reachable.
- **Broken schedules**: a job that fails N consecutive runs (default 3) is
  **paused** (`enabled=false`) with a DM notice, never retried forever.
- **Dispatcher never throws**: per-job try/catch; the dispatcher itself
  remains alive for the remaining jobs.
- **Overlapping ticks**: atomic lease prevents double-claim.
- **Postgres absent** (e.g. local world): `claimDue` returns `[]`; the agent
  boots and answers fine (same degradation as the provider registry).

## 7. Testing

- **Unit (bun test, agent package):**
  - `lib/schedule-admin.test.ts` — cadence→`next_run_at` math: every-minutes
    increments, daily/weekly/monthly at a given time+timezone, DST-adjacent
    rollovers, raw cron (UTC), validation errors.
  - `lib/schedule-store.test.ts` — `claimDue` atomic lease behavior against a
    pg-mem fixture (repo convention: provider registry tests use pg-mem),
    run-row transitions, cascade delete.
  - `shared` — `encodeToken`/`decodeToken` round-trip with the new optional
    `scheduleRunId` field (backward compatible).
  - Tools — input validation and renderers are pure functions; unit-test the
    schema contracts (repo style: no DB in tool tests).
- **Boot smoke**: `bunx eve start` without new keys still boots; the
  dispatcher schedule is discoverable (`eve info`);
  `POSTHOG_*`/`COMPOSIO_*` absent → no behavior change.
- **Evals** (backlog): `schedule-created`, `schedule-runs-reporting` (model
  can list runs and name the last output), `schedule-delivery` harness.
- **Live E2E (user credentials)**: "remind me in 2 minutes" → DM delivered →
  "what did that job do?" from `schedule_runs`; verify a recurring daily job
  fires and its log row appears; verify approval gates a `schedule_create`.

## 8. Docs

- `docs/ENV.md`: unchanged (no new env vars).
- `README.md`: brief "Scheduled jobs" section under operations — how jobs are
  created (plain Discord), where they run (one dispatcher), how to inspect
  them (ask the agent), and the delivery model.
- Spec + plan committed as before.

## 9. Success criteria

From Discord (approvals on creates/updates/deletes/triggers):

1. "Remind me tomorrow at 9am to call the dentist" → job created, delivered
   the next day at 9am (owner's timezone), DM received.
2. "Digest my calendar every weekday at 8am" → runs M–F at 8am, calendar
   summary delivered, run rows recorded.
3. "What did the morning job do?" → `schedule_runs` summarizes status +
   output of the recent runs.
4. A broken/long-failing job pauses itself and notifies, never retries
   forever.
5. The agent boots and answers with no scheduled jobs configured.
