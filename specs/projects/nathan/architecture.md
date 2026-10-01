---
status: complete
---

# Architecture: Nathan

Nathan is one Cloudflare Worker, written in TypeScript. It has a small **platform core** and a set of **features**; V1 has one feature, `pr_management`. This doc covers the stack, the platform core, data storage, the request lifecycle, and testing and deployment. Feature internals and the two gateways are in `components/`.

Research backing the stack choices: [research/platform-stack/summary.md](research/platform-stack/summary.md).

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers (Paid plan, already owned), **no `nodejs_compat`** | Near-zero cold start fits Slack's 3s ack. Cron, Queues, D1 and KV are built in. |
| Language | TypeScript, `strict: true` | Stable on Workers (Python Workers are too new) |
| Slack framework | `slack-edge` (via `slack-cloudflare-workers`), **only imported inside `src/slack/`** | The only maintained Workers-native Slack framework. It has ack plus lazy handlers, and Bolt JS doesn't run on Workers without shims. Its bus factor is small, so it sits behind an adapter. |
| GitHub | `@octokit/core`, `@octokit/auth-app`, `@octokit/webhooks-methods`, **only imported inside `src/github/`** | Verified in workerd. The private key must be PKCS#8 (§8). |
| Relational state | **D1** (SQLite) | Small relational state (PR records, cards, debounce, job runs). Plain SQL with migrations. |
| Token cache | **KV** | Caches the GitHub installation token (1h TTL) across isolates, which keeps the modal-validation path fast. |
| Durable async work | **Cloudflare Queues** (one queue + DLQ) | At-least-once delivery with retries. `delaySeconds` implements the 60s debounce. |
| Scheduling | One **Cron Trigger** every 15 minutes, plus an in-app scheduler | Cron expressions are UTC-only, and the report is "09:30 ET" across daylight-saving changes. The in-app scheduler handles timezones (§4.5). |
| Validation | `zod` | Config schema, queue message schemas |
| Time zones | `luxon` | Time-zone-correct weekend math using Intl, which workerd provides |
| Tooling | npm, Vitest with `@cloudflare/vitest-pool-workers`, Biome (lint+format), `tsc --noEmit`, Wrangler | Per user preference (npm). Tests run in real workerd, so Workers-only bugs (e.g., PKCS#1 keys) surface locally. |

There's no ORM and no Durable Objects. At this scale, hand-written SQL in per-feature repository modules is the clearest option, and the easiest for coding agents to change.

## 2. Repository Layout

```
nathan.config.ts                 # team config (users, repos, channels, thresholds, messages)
wrangler.jsonc                   # bindings, cron, envs (staging, production)
migrations/                      # D1 SQL migrations (0001_init.sql, …), shared by all features
slack-manifest.production.yaml   # Slack app manifests (scopes, shortcuts, commands, URLs)
slack-manifest.staging.yaml
docs/setup.md                    # one-time setup: apps, secrets, key conversion
src/
  index.ts                       # Worker entry: fetch / scheduled / queue → core
  core/
    env.ts                       # Env bindings type
    app.ts                       # builds the platform: config, gateways, features, registries
    feature.ts                   # Feature + Registrar interfaces
    http.ts                      # router: /slack/events, /github/webhooks, /healthz
    jobs.ts                      # typed queue jobs: define/enqueue/dispatch, debounce
    scheduler.ts                 # tick → due scheduled tasks (tz-aware), job_runs bookkeeping
    config.ts                    # zod schema for platform config + loader + env overlay
    directory.ts                 # UserDirectory (GitHub↔Slack, tz lookup with cache)
    time.ts                      # Clock, weekendExcludedHours(), formatAge()
    errors.ts                    # reportError() → logs + admin channel (deduped)
    log.ts                       # structured JSON logger
    db.ts                        # D1 helpers (typed first/all/run, tx batch)
  slack/                         # SlackGateway — see components/slack_gateway.md
  github/                        # GitHubGateway — see components/github_gateway.md
  features/
    index.ts                     # the list of enabled features (the only registry edit)
    pr_management/               # see components/pr_*.md
test/
  fakes/                         # FakeSlack, FakeGitHub, FakeClock, fixture builders
  …                              # mirrors src/
```

**Import rules** (enforced by Biome `noRestrictedImports`):
- Features import only from `core/`, `slack/index.ts`, `github/index.ts`, and their own folder.
- Features never import each other.
- Nothing outside `src/slack/` imports `slack-edge`; nothing outside `src/github/` imports `@octokit/*`.

## 3. The Feature Model

A feature is a module that exports a `Feature`:

```ts
// core/feature.ts
export interface Feature<C = unknown> {
  id: string;                          // "pr_management"; also its config key and table prefix
  configSchema: z.ZodType<C>;          // validated at startup
  register(r: Registrar<C>): void;     // declare everything here; no side effects
}

export interface Registrar<C> {
  config: C;
  services: Services;                  // see below
  slack: SlackRegistry;                // shortcuts, views, actions, /nathan subcommands, home sections, events
  github: { on(event: GitHubEventName, handler: GitHubWebhookHandler): void };
  jobs: { define<P>(name: string, schema: z.ZodType<P>, handler: JobHandler<P>): JobRef<P> };
  schedule(task: ScheduledTask): void; // { name, when: { everyHour } | { at:"09:30", tz, days:"weekdays" }, run }
}

export interface Services {
  slack: SlackClient;        // outbound Slack API (components/slack_gateway.md)
  github: GitHubGateway;     // reader + allow-listed writer (components/github_gateway.md)
  db: Db;                    // D1 helpers
  directory: UserDirectory;
  clock: Clock;
  log: Logger;
  reportError(err: unknown, context: Record<string, unknown>): Promise<void>;
  enqueue<P>(job: JobRef<P>, payload: P, opts?: { delaySeconds?: number }): Promise<void>;
  debounce<P>(job: JobRef<P>, key: string, payload: P, opts: { windowSeconds: number; maxWaitSeconds: number }): Promise<void>;
}
```

- `features/index.ts` exports `features: Feature[] = [prManagement]`. To add a feature, create a folder and add it to that array.
- A feature can be disabled with `enabled: false` in its config section. A disabled feature's `register` is never called.
- `/nathan help` is generated from the registered subcommands. The App Home view is the concatenation of the feature sections, ordered by each section's `order`.

**Handler contracts**:
- **Slack ack** handlers must return in under 2.5s.
- **GitHub webhook** handlers must only record and enqueue, and finish in under 1s, because GitHub times out at 10s and never redelivers.
- **Job and scheduled task** handlers may run up to 15 minutes, must be idempotent (Queues are at-least-once), and must catch their own expected errors.

## 4. Platform Core

### 4.1 Entry and routing (`index.ts`, `core/http.ts`)

`index.ts` exports `{ fetch, scheduled, queue }`. Each one builds the app once per isolate (`core/app.ts`, memoized), then delegates:
- `POST /slack/events`: `SlackGateway.handle(request, ctx)`. slack-edge verifies the signature, runs the ack, and runs the lazy handler via `ctx.waitUntil`.
- `POST /github/webhooks`: verify `X-Hub-Signature-256` (401 on mismatch). Then dedupe on `X-GitHub-Delivery` (insert into `webhook_deliveries`; if the delivery is already present, return 200). Then call each registered handler for `X-GitHub-Event` inline, and return 202. Payload parsing and PR-key extraction are in `components/github_gateway.md`.
- `GET /healthz`: returns 200 with `{ env, version }`.
- Anything else: 404.

### 4.2 Config (`nathan.config.ts`, `core/config.ts`)

`nathan.config.ts` default-exports `defineConfig({...})`, which is typed, so a typo is a type error. Its shape:

```ts
export default defineConfig({
  defaults: { timezone: "America/Toronto" },
  users: [{ github: "scosman", slack: "U0123" }, /* tz?: "Asia/Shanghai" override */],
  admin: { slackChannel: "C_ADMIN" },              // job failures, DLQ alerts
  features: {
    pr_management: { enabled: true, repos: ["Kiln-AI/Kiln", "Kiln-AI/nathan"], channel: "C_PRS", triager: "daniel-gh", /* … */ },
  },
  environments: {
    staging: { dryRun: true, testChannel: "C_NATHAN_TEST", features: { pr_management: { channel: "C_NATHAN_TEST" } } },
    production: {},
  },
});
```

- The environment comes from the `NATHAN_ENV` var in `wrangler.jsonc`. The loader deep-merges `environments[env]` over the base config, then validates:
  - the platform schema, plus each enabled feature's `configSchema`
  - cross-references: the triager and every user must be unique, and repos must be `owner/name`
- Invalid config throws at isolate start. Every request then returns 500, and the logs show the zod error. CI also runs `npm run check:config`, so a bad config can't merge.
- Slack channels are referenced by **ID**, not name, because names change and the API needs IDs.

### 4.3 Jobs and Queues (`core/jobs.ts`)

One queue (`nathan-jobs`) carries all jobs, with a dead-letter queue (`nathan-jobs-dlq`) after 3 retries. Messages are `{ job: "<featureId>.<name>", payload, attempt? }`.

- **Define:** `jobs.define(name, schema, handler)` registers the job under `<featureId>.<name>`.
- **Dispatch:** the consumer validates the payload against the schema (an invalid message goes to `reportError` and is acked), then runs the handler. A thrown error calls `msg.retry({ delaySeconds: 30 * 2^attempts })`.
- **Final retry:** when the handler fails on its last retry (`msg.attempts >= 3`), the consumer calls the handler's optional `onGiveUp(payload, err)`, which pr_management uses to DM the submitter, and then `reportError`.
- **DLQ:** a second consumer drains the DLQ and only calls `reportError`.

**Debounce** (`services.debounce`) is trailing-edge, with a max wait. It's used for the 60s PR-event coalescing:

```
debounce(job, key, payload, { windowSeconds: 60, maxWaitSeconds: 300 }):
  UPSERT debounce(key) SET version = version + 1, first_at = COALESCE(first_at, now), payload = ?
  enqueue({ job: "core.debounced", payload: { key, version } }, delaySeconds = windowSeconds)

consumer "core.debounced"({ key, version }):
  row = SELECT debounce WHERE key
  if !row: ack                                    // already handled
  if row.version != version AND now - row.first_at < maxWait: ack   // a later message will handle it
  DELETE debounce WHERE key AND version = row.version   // claim it; if 0 rows changed, ack
  run the target job inline with row.payload
```

Payload merging is the caller's job. pr_management stores the PR key as the payload and keeps its own event log (`pr_events`), so the payload "last write wins" is fine.

### 4.4 Directory (`core/directory.ts`)

`UserDirectory` is built from `config.users`:
- Lookups: `bySlack(id)` and `byGithub(login)`. Login matching is case-insensitive, and a `[bot]` suffix is normalized away.
- `timezone(slackId)`: uses the config override if set. Otherwise it reads `slack_user_tz` (D1, 24h TTL), falling back to `users.info`, and finally to `defaults.timezone`.
- `slackMention(login)`: returns `<@U…>` for a mapped login, or null.

### 4.5 Scheduler (`core/scheduler.ts`)

Wrangler has a single cron: `*/15 * * * *`. On each tick:
1. `tickTime = floor(scheduledTime to 15m)`
2. For each registered task, compute whether a fire time falls in `(lastRun, tickTime]`:
   - `everyHour`: fires on ticks where `minute == 0`.
   - `{ at: "HH:MM", tz, days }`: the most recent local occurrence of `HH:MM` in `tz` on a matching weekday, converted to UTC.
3. A due task claims itself (`UPDATE job_runs SET last_run_at=? WHERE name=? AND last_run_at=?`, or INSERT on first run). It runs only if the claim succeeds, so overlapping ticks never double-run it. Then it runs inside `ctx.waitUntil`, wrapped in try/catch, with `reportError` on failure.
4. If a task was missed (the previous tick failed), it runs once on the next tick, never several times over.

Cron invocations get 15 minutes of wall time, and the Paid plan's CPU limit for crons under 1h is 30s. The sweep is I/O-bound with minimal CPU, which is well within that.

### 4.6 Time (`core/time.ts`)

- `Clock` is an interface: `{ now(): DateTime }`. Production uses `SystemClock`, and tests use `FakeClock`. **Nothing reads `Date.now()` directly** (Biome rule plus review).
- `weekendExcludedHours(start, end, tz)`: walks local calendar days from `start` to `end` in `tz` and sums the overlap of `[start,end)` with each Mon–Fri local day. It handles DST days (23h or 25h) through luxon's zone math.
- `formatAge(hours)` returns strings like `"3h"`, `"2d 4h"`, `"5w"`.

### 4.7 Errors and logging (`core/errors.ts`, `core/log.ts`)

- `log.info/warn/error(msg, fields)` emits one JSON line to the console, which Workers Logs captures (observability is enabled in `wrangler.jsonc`).
- `reportError(err, context)`:
  1. Logs the error.
  2. Computes `key = hash(context.source + err.message)`.
  3. If `admin_alerts(key)` was posted within 1h, stops there.
  4. Otherwise it upserts that row and posts to `config.admin.slackChannel`.
  5. If posting to Slack fails, it only logs (no recursion).
- **Isolation between features:** every handler invocation (Slack, GitHub, job, scheduled) runs through `core.runIsolated(featureId, fn)`, which catches errors and calls `reportError`. A failing feature never breaks routing or other features.

### 4.8 Dry run

When `dryRun: true`:
- `SlackClient` is wrapped by `DryRunSlackClient`. Every post or update goes to `testChannel`, prefixed with `[dry-run → <original channel or DM target>]`, and mentions are rewritten to plain names so nobody gets pinged. Reads pass through.
- `GitHubGateway.writer` is replaced by a logger, so nothing is written.

Staging always runs with dry run on unless its config says otherwise.

## 5. Data Model (D1)

All migrations live in `/migrations` (applied by `wrangler d1 migrations apply`). Core tables have no prefix, and feature tables are prefixed with the feature id.

| Table | Owner | Purpose |
|---|---|---|
| `job_runs(name PK, last_run_at)` | core | Scheduler claims (§4.5) |
| `debounce(key PK, version, first_at, payload)` | core | Debounce (§4.3) |
| `webhook_deliveries(id PK, received_at)` | core | GitHub delivery dedupe; rows older than 7 days are pruned by an hourly core task |
| `admin_alerts(key PK, last_posted_at)` | core | Error alert dedupe |
| `slack_user_tz(slack_id PK, tz, fetched_at)` | core | Directory time-zone cache |
| `pr_prs`, `pr_events` | pr_management | See [components/pr_state_and_sync.md](components/pr_state_and_sync.md) |

KV (`NATHAN_KV`) holds only `gh:installation-token` → `{ token, expiresAt }`.

## 6. Request Lifecycles (summary)

The component docs have the details.

```
Slack shortcut ──► /slack/events ─ ack: views.open(modal) ───────────────────────────► user sees form
Modal submit   ──► /slack/events ─ ack: validate (≤2.2s: config + GitHub GET PR) ─┬─► inline errors
                                                                                   └─► enqueue pr_management.request_review
Queue          ──► request_review: GitHub requestReviewers ► refresh PR ► post/update card ► (DM on give-up)
GitHub webhook ──► /github/webhooks ─ verify ► dedupe ► pr handler: record pr_events, debounce(refresh, 60s) ► 202
Queue (60s)    ──► refresh PR: fetch ► computeStatus ► diff vs stored ► card update / create ► handoff reply
Cron (hourly)  ──► sweep: fetch all open PRs ► refresh each ► reminders ► draft nudges ► finalize vanished PRs
Cron (09:30 ET weekdays) ──► sweep ► daily report (+ Monday weekly sections)
app_home_opened / `/nathan prs` ──► lazy: read pr_prs from D1 ► views.publish / response_url
```

There are two sources of truth:
- **GitHub is authoritative for PR state.** Nathan recomputes from GitHub rather than applying event payloads, and the hourly sweep heals anything that was missed.
- **D1 is authoritative only for Nathan's own facts:** card location, modifiers and note, reminder level, last nudge, and the last computed status (needed to detect handoffs).

## 7. Error Handling Strategy

| Situation | Handling |
|---|---|
| Invalid config | Fails at isolate start; CI blocks the merge |
| Bad Slack or GitHub signature | 401, logged at warn, no alert |
| GitHub call times out during modal validation | Inline modal error: "GitHub didn't answer in time, try again." |
| Transient GitHub/Slack error in a job | Throw, and the queue retries with backoff. After 3 attempts, `onGiveUp` runs, then `reportError`, and the message goes to the DLQ. |
| Slack 429 | `slack-web-api-client` retries 429s automatically (it honors `Retry-After`) |
| GitHub rate limit or secondary limit | Throw a `RateLimitedError(retryAfter)`, which jobs retry with that delay. The sweep aborts and the next sweep catches up. |
| `mergeable == UNKNOWN` | Keep the previously stored value for the conflict rule (see the state component) |
| PR vanished, transferred, or the repo was removed from config | Its stored record is finalized or ignored by the sweep, and nothing errors |
| Bug in one feature | `runIsolated` catches it and reports to the admin channel; other features are unaffected |

## 8. Security

- **GitHub App permissions:** Metadata R, Pull requests R/W, Checks R, Commit statuses R. Subscribed events: `pull_request`, `pull_request_review`, `check_run`, `status`.
- **The only GitHub write path is `GitHubWriter.requestReviewers`.** The Octokit instance is module-private to `src/github/`. The reader exposes only typed query functions, and its GraphQL helper rejects any document containing `mutation`. A unit test asserts the writer's public surface is exactly `{ requestReviewers }`.
- **Private key:** stored as a PKCS#8 PEM in the secret `GITHUB_APP_PRIVATE_KEY`. `docs/setup.md` gives the conversion command (`openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem`). At startup the key header is checked, and a PKCS#1 header (`BEGIN RSA PRIVATE KEY`) throws a clear error.
- **Secrets** are set with `wrangler secret put` per environment: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET`. An empty or missing secret throws at startup.
- **Slack bot scopes:** `commands`, `chat:write`, `users:read`, `reactions:write`, `im:write`. Nathan must be invited to `#prs`; it doesn't use `chat:write.public`.

## 9. Environments and Deployment

- **Wrangler environments:** `staging` and `production`. Each has its own D1 database, KV namespace, queue plus DLQ, `NATHAN_ENV` var and secrets.
- **Each environment also has its own Slack app and GitHub App,** because each app has one request URL. Staging's Slack app uses `/nathan-staging` and its own shortcut callback IDs. Its GitHub App is installed on the same repos, and dry run means it never writes.
- **GitHub Actions:**
  - `ci.yml` on every PR runs `npm ci`, `npm run check` (`biome ci`, `tsc --noEmit`, `check:config`, `vitest run`).
  - `deploy.yml` runs on push to `main`: apply remote D1 migrations to production, then `wrangler deploy --env production`.
  - `deploy-staging.yml` is `workflow_dispatch` with a `ref` input, and does the same for staging.
  - The `CLOUDFLARE_API_TOKEN` secret lives in GitHub.
- **Migrations must be backward compatible** with the previous Worker version (add columns, don't rename), because migrations apply before the deploy.

## 10. Testing Strategy

- **Runner:** Vitest with `@cloudflare/vitest-pool-workers`, so tests run inside workerd with real D1, KV and Queues in Miniflare. Migrations are applied in `beforeAll`.
- **Fakes, not HTTP mocks:**
  - `FakeSlack` implements `SlackClient` and records calls (posts, updates, views, DMs) with message ts generation.
  - `FakeGitHub` implements `GitHubGateway` from in-memory PR fixtures, and records `requestReviewers` calls.
  - `FakeClock` provides time.
  - Features are tested through `core/app.ts` with fakes injected via a `createApp(env, overrides)` seam.
- **Fixture builders:** `aPR({ ...overrides })` builds normalized `PRData`, and `aReview`, `aCheck` and others build the parts.
- **Gateway tests:**
  - GraphQL response → `PRData` normalization uses recorded JSON fixtures in `test/fixtures/github/`.
  - Slack signature and webhook signature verification use known test vectors.
  - A PKCS#8 JWT signing test runs in workerd, and a PKCS#1 key must be rejected.
- **Golden tests:** Block Kit output (cards, report, home, modal) uses Vitest file snapshots, so message changes are visible in PR diffs.
- **Coverage expectations:**
  - pure logic (state engine, reminders, handoff diff, metrics, time): 100% of branches
  - everything else: meaningful paths, including every error row in §7
- **Local dev loop:** run the tests. For live behavior, use `workflow_dispatch` to deploy a branch to staging (dry run into `#nathan-test`). `npm run dev` (`wrangler dev`) works with a tunnel, but isn't required.

## 11. Component Areas

There are no separate component docs: the user chose to go straight to the implementation plan. Each phase's coding agent designs its component's internals in its phase plan (`phase_plans/phase_N.md`). That design stays within this architecture, the functional spec and the research. The areas, with the research docs to read for each:

| Area | Covers | Read |
|---|---|---|
| Slack gateway (`src/slack/`) | `SlackClient`/`SlackRegistry`, the slack-edge adapter (cached `authorize`, `startLazyListenerAfterAck: true`, lazy handlers re-check validity), `/nathan` router, App Home composition, dry-run wrapper, manifests | [slack-app-framework](research/platform-stack/slack-app-framework/summary.md) |
| GitHub gateway (`src/github/`) | Auth plus KV token cache, `PRData` normalization, the sweep, single-PR and recent-PR queries, two-phase `isRequired`, webhook parsing and fork `head_sha` lookup, writer | [github-app-integration](research/platform-stack/github-app-integration/summary.md), especially `state-model-data.md`, `webhooks.md`, `workers-libraries.md` |
| PR state and sync | `computeStatus` (spec §4.2), `pr_prs`/`pr_events`, refresh pipeline (diff → effects), card, handoffs, sweep, finalize | spec §4.1–4.5 |
| Request PR | Modal, validation within the ack budget, `request_review` job, partial-failure DM | spec §4.3, [workers-ack-pattern](research/platform-stack/slack-app-framework/workers-ack-pattern.md) |
| Reminders and drafts | Due-level algorithm, per-owner time zones, templates and variant rotation, draft DMs | spec §4.6, §4.8 |
| Report and personal queue | Daily and Monday sections, metrics, Block Kit size limits and splitting, App Home, `/nathan prs` | spec §4.7, §4.9, [metrics.md](research/platform-stack/github-app-integration/metrics.md) |
