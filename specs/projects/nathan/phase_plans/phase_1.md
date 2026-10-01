---
status: complete
---

# Phase 1: Scaffold and platform core

## Overview

Stand up the repository and the platform core every later phase builds on: tooling (npm, strict TypeScript, Biome with import rules, Vitest in workerd), Wrangler config with staging and production environments, CI and deploy workflows, the typed config file with environment overlay and validation, core services (clock/time, logger, error reporting, D1 helpers, core migration), the HTTP router with `/healthz`, the feature model and registrar, queue jobs (retry, give-up, DLQ, debounce) and the time-zone-aware scheduler. It ends with test fakes, fixture builders and a `docs/setup.md` skeleton.

No product feature ships in this phase: `features/index.ts` is an empty list. The Slack and GitHub gateways come in phases 2 and 3; this phase only defines the minimal `SlackClient` interface that `reportError` needs (`postMessage`), so the Registrar gets its `slack` and `github` registries, and `Services` its `github` and `directory` entries, in those phases.

## Steps

1. **Tooling**
   - `package.json` scripts: `dev` (`wrangler dev`), `test` (`vitest run`), `lint` (`biome ci .`), `format` (`biome format --write .`), `typecheck` (`tsc --noEmit`), `check:config` (`tsx scripts/check-config.ts`), `check` (all four: lint, typecheck, check:config, test), `cf-typegen` (`wrangler types`).
   - Dependencies: `zod`, `luxon`. Dev: `wrangler`, `vitest` 4, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, `@biomejs/biome`, `typescript`, `tsx`, `@types/luxon`.
   - `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `module`/`moduleResolution` `bundler`, `types: ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"]`, `noEmit`.
   - `biome.json`: recommended rules, formatter on; `noRestrictedImports` so only `src/slack/**` imports `slack-edge`/`slack-cloudflare-workers`, only `src/github/**` imports `@octokit/*`; inside `src/features/**`, slack/github internals (anything but their `index`) and other features' folders are forbidden; `noRestrictedGlobals` denies `Date` everywhere in `src/` except `src/core/time.ts` (the "nothing reads `Date.now()`" rule).
   - `.gitignore`: `node_modules`, `.wrangler`, `.dev.vars`, coverage.

2. **`wrangler.jsonc`**: `main: src/index.ts`, recent `compatibility_date`, no `nodejs_compat`, `observability.enabled`, `triggers.crons: ["*/15 * * * *"]`, `version_metadata` binding `CF_VERSION_METADATA`. Top level is the local/test env (`NATHAN_ENV: "development"`). `env.staging` and `env.production` repeat every binding with their own names: `vars.NATHAN_ENV`, D1 `DB` (`nathan-<env>`, `migrations_dir: migrations`), KV `NATHAN_KV`, queue producer `JOBS` → `nathan-jobs-<env>`, consumers for `nathan-jobs-<env>` (`max_retries: 3`, `dead_letter_queue: nathan-jobs-<env>-dlq`) and for the DLQ. IDs are placeholders filled during setup (docs/setup.md).

3. **`src/core/env.ts`**: `Env` interface: `DB: D1Database`, `NATHAN_KV: KVNamespace`, `JOBS: Queue<JobMessage>`, `NATHAN_ENV: string`, `CF_VERSION_METADATA?: WorkerVersionMetadata`. Plus `requireSecret(env, name): string` (throws on missing/empty) for the gateways in later phases.

4. **`src/core/time.ts`** (the only file allowed to touch `Date`):
   ```ts
   export interface Clock { now(): DateTime }
   export const systemClock: Clock;
   export function weekendExcludedHours(start: DateTime, end: DateTime, tz: string): number;
   export function formatAge(hours: number): string; // "<1h", "3h", "2d 4h", "1w 3d", "5w"
   export function isValidTimeZone(tz: string): boolean;
   ```
   `weekendExcludedHours` walks local calendar days in `tz` and sums the overlap of `[start, end)` with each Mon–Fri local day (luxon zone math, so 23h/25h DST days are right). `end <= start` → 0.

5. **`src/core/log.ts`**: `Logger { debug, info, warn, error, child(fields) }`. `createConsoleLogger(base)` emits one JSON line per call (`{ level, msg, ts, ...fields }`), serializing `Error` values to `{ name, message, stack }`.

6. **`src/core/db.ts`**: `Db` over `D1Database`: `first<T>(sql, ...params)`, `all<T>(sql, ...params)`, `run(sql, ...params): Promise<{ changes }>`, `statement(sql, ...params)` and `batch(statements)` (D1 batch is a transaction).

7. **`migrations/0001_init.sql`**: core tables `job_runs(name PK, last_run_at INTEGER)`, `debounce(key PK, job, version, first_at, payload)`, `webhook_deliveries(id PK, received_at)`, `admin_alerts(key PK, last_posted_at)`, `slack_user_tz(slack_id PK, tz, fetched_at)`. Times are epoch milliseconds.

8. **`src/slack/index.ts`** (minimal, grown in phase 2): `SlackClient { postMessage(msg: { channel; text; blocks?; thread_ts? }): Promise<{ channel; ts }> }`, and `unwiredSlackClient`, which throws "Slack gateway not wired yet" (production placeholder until phase 2).

9. **`src/core/config.ts`**:
   - Zod platform schema (strict objects): `defaults.timezone` (valid IANA zone), `users: { github, slack, tz? }[]`, `admin.slackChannel` (channel ID), `dryRun` (default false), `testChannel` (channel ID; required when `dryRun`), `features: Record<string, { enabled: boolean, ...section }>`.
   - Cross-checks: GitHub logins unique (case-insensitive), Slack IDs unique, every feature section names a known feature.
   - `defineConfig(config: NathanConfigInput): NathanConfigInput` (typed identity), with `environments: Record<string, DeepPartial<…>>`.
   - `loadConfig(raw, envName, features): LoadedConfig`: requires `environments[envName]`, deep-merges it over the base (objects merge, arrays and scalars replace), validates the platform schema, then each enabled feature's `configSchema` against its section minus `enabled`. Returns `{ env, platform, features: Map<id, parsedConfig> }` (enabled features only). Errors throw `ConfigError` with a readable, path-prefixed message per issue.

10. **`src/core/errors.ts`**:
    - `RetryAfterError(message, retryAfterSeconds)`: a job error that asks for a specific retry delay (phase 3's `RateLimitedError` extends it).
    - `createErrorReporter({ log, db, clock, slack, adminChannel })` → `reportError(err, context)`: log; key = SHA-256 hex of `context.source + message`; skip if `admin_alerts.last_posted_at` is within 1h; else upsert and post to the admin channel; Slack failures are only logged.
    - `runIsolated(source, fn, reportError)`: awaits `fn`, catches anything, reports, never throws.

11. **`src/core/feature.ts`**: `Feature<C>`, `Registrar<C>` (`config`, `services`, `jobs.define`, `schedule`), `Services` (`slack`, `db`, `clock`, `log`, `reportError`, `enqueue`, `debounce`), `ScheduledTask` (`{ name, when: { everyHour: true } | { at: "HH:MM", tz, days: "weekdays" | "everyday" }, run(ctx) }`), `AnyFeature`, `defineFeature`.

12. **`src/core/jobs.ts`**:
    - `JobMessage = { job: string; payload: unknown }` (zod-validated envelope).
    - `JobRegistry`: `define(featureId, name, schema, handler, { onGiveUp? })` → `JobRef<P>` named `<featureId>.<name>` (duplicate names throw).
    - `createEnqueue(queue)` → `enqueue(ref, payload, { delaySeconds? })` validates payload against the schema before sending.
    - `dispatchBatch(batch, registry, reportError, log)`: invalid envelope, unknown job, or invalid payload → `reportError` and `ack`. Success → `ack`. Failure on attempt `< MAX_ATTEMPTS (3)` → `retry({ delaySeconds })`, where the delay is `RetryAfterError.retryAfterSeconds` or `30 * 2^attempts`, capped at the Queues 12h maximum. Failure on the last attempt → `onGiveUp(payload, err)` (its own errors reported), `reportError`, then `ack`.
    - `drainDeadLetters(batch, reportError)`: report each message with its job name, then ack.
    - Debounce: `createDebounce({ db, clock, enqueue, debouncedRef })` → `debounce(ref, key, payload, { windowSeconds, maxWaitSeconds })`: UPSERT `debounce` row (`key = <job>:<key>`, bump version, keep `first_at`, replace payload), `RETURNING version`; enqueue `core.debounced { key, version, maxWaitSeconds }` with `delaySeconds = windowSeconds`.
    - `core.debounced` handler: no row → done; stale version and under max wait → done; claim with `DELETE … WHERE key AND version`; 0 changes → done; else enqueue the target job with the stored payload; if that enqueue fails, restore the row (`INSERT … ON CONFLICT DO NOTHING`) and rethrow so the message retries.

13. **`src/core/scheduler.ts`**:
    - `validateWhen(when)` at registration: `HH:MM` 00:00–23:59, known `tz`.
    - `latestFireAtOrBefore(when, t): DateTime`: `everyHour` → start of the UTC hour; `at` → most recent local `HH:MM` on a matching day in `tz` that is `<= t`.
    - `Scheduler.tick(scheduledTime, ctx)`: `tickTime` = floor to 15 minutes. For each task: `fire = latestFireAtOrBefore(when, tickTime)`; `lastRun = job_runs.last_run_at`, or `tickTime - 15m` when no row exists (so a new task doesn't fire for an old slot on first deploy). Due when `fire > lastRun`. Claim with `UPDATE … SET last_run_at = fire WHERE name = ? AND last_run_at = ?` (or `INSERT … ON CONFLICT DO NOTHING` when no row); run only when 1 row changed, via `runIsolated`. Returns a promise of all runs (the entry point hands it to `ctx.waitUntil`).

14. **`src/core/http.ts`**: `Router` with `on(method, path, handler)` and `handle(request, ctx)`: exact path match, 404 otherwise, 405 on a known path with the wrong method. Core registers `GET /healthz` → `{ env, version }` (version from `CF_VERSION_METADATA.id`, else `"dev"`).

15. **`src/core/app.ts`**:
    - `createApp(env, overrides?: { config?, features?, clock?, slack?, queue?, log? })`: loads config (default: `nathan.config.ts`), builds services, registers the built-in `core` feature (the `core.debounced` job and an hourly `core.prune_webhook_deliveries` task deleting rows older than 7 days), then calls `register` on each enabled feature with a feature-scoped Registrar (job and task names prefixed with the feature id, all handlers isolated by feature id).
    - `App` exposes `config`, `services`, `fetch(request, ctx)`, `scheduled(controller, ctx)`, `queue(batch, ctx)`. The queue handler routes `*-dlq` queues to `drainDeadLetters`, others to `dispatchBatch`.
    - `getApp(env)`: memoized per isolate.

16. **`src/index.ts`**: `export default { fetch, scheduled, queue } satisfies ExportedHandler<Env, JobMessage>`. `fetch` returns 500 (and logs) when the app fails to build, e.g. invalid config.

17. **`src/features/index.ts`**: `export const features: AnyFeature[] = []`.

18. **`nathan.config.ts`**: `defineConfig` with `defaults.timezone: "America/Toronto"`, an empty-ish `users` list, admin channel placeholder, `features: {}`, and `environments: { development: { dryRun: true, testChannel }, staging: { dryRun: true, testChannel }, production: {} }`.

19. **`scripts/check-config.ts`**: loads `nathan.config.ts` with `features` for every environment key, printing each result; exits 1 on any `ConfigError`.

20. **CI/CD** (`.github/workflows/`):
    - `ci.yml`: on pull_request and push to main: `npm ci`, `npm run check`.
    - `deploy.yml`: on push to `main`: `npm ci`, `wrangler d1 migrations apply DB --remote --env production`, `wrangler deploy --env production`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.
    - `deploy-staging.yml`: `workflow_dispatch` with a `ref` input; same steps for `--env staging`.

21. **Test infrastructure** (`vitest.config.ts`, `test/`):
    - `vitest.config.ts`: `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { TEST_MIGRATIONS } } })`, migrations read with `readD1Migrations`.
    - `test/setup.ts`: applies D1 migrations before each test file; tests get a clean DB.
    - `test/fakes/clock.ts` `FakeClock` (`set`, `advance`), `test/fakes/slack.ts` `FakeSlack` (records posts, generates `ts`, can be told to fail), `test/fakes/queue.ts` `RecordingQueue` (records sends with delays), `test/fakes/log.ts` `MemoryLogger`, `test/fakes/batch.ts` `fakeMessage`/`fakeBatch` with recorded ack/retry.
    - `test/builders/config.ts` `aConfig(overrides)` (a valid raw config) and `test/helpers/app.ts` `testApp(overrides)` (builds the app with fakes on the real D1).

22. **`docs/setup.md` skeleton**: headings for prerequisites, Cloudflare resources (D1, KV, queues + DLQs per env, filling IDs into `wrangler.jsonc`), applying migrations, GitHub Actions secrets, and placeholders for the Slack app, GitHub App and secrets sections filled in by phases 2, 3 and 8.

## Tests

- `test/core/time.test.ts`
  - `weekendExcludedHours` counts a full weekday, excludes a full weekend, spans Fri→Mon correctly, partial days at both ends, start ≥ end returns 0, DST spring-forward (23h) and fall-back (25h) weekdays, and owner-tz weekend boundaries (a Friday evening ET that's Saturday in Shanghai).
  - `formatAge` boundaries: `<1h`, hours, days with and without hours, weeks with and without days.
  - `systemClock.now()` returns a UTC DateTime close to the real time.
- `test/core/log.test.ts`: JSON line shape, child fields merged, `Error` serialized.
- `test/core/db.test.ts`: first/all/run/batch against real D1, `changes` count, `first` returns null on no row.
- `test/core/config.test.ts`
  - valid config loads; env overlay deep-merges objects and replaces arrays
  - unknown env, invalid tz, bad channel ID, dryRun without testChannel, duplicate GitHub login (case-insensitive) and duplicate Slack ID all fail with readable messages
  - unknown feature section fails; disabled or missing section skips the feature; enabled feature's schema validates its section (errors are path-prefixed with the feature id); `enabled` is stripped before the feature schema
  - the repo's `nathan.config.ts` loads for every environment
- `test/core/errors.test.ts`: `reportError` posts once, is deduped within 1h, posts again after 1h, different source posts separately, Slack failure only logs; `runIsolated` swallows and reports.
- `test/core/jobs.test.ts`
  - define/enqueue: names prefixed, duplicate rejected, invalid payload rejected at enqueue, delaySeconds passed through
  - dispatch: success acks; invalid envelope, unknown job and invalid payload report and ack; a failure retries with exponential delay; `RetryAfterError` uses its delay; delay is capped; the last attempt calls `onGiveUp`, reports and acks; an `onGiveUp` failure is also reported
  - DLQ drain reports and acks each message
  - debounce: first call inserts and enqueues the delayed check; repeated calls bump version and keep `first_at`; the latest message fires the target once; stale messages under max wait do nothing; a stale message past max wait fires and the later message then no-ops; a missing row no-ops; an enqueue failure restores the row and rethrows
- `test/core/scheduler.test.ts`
  - `latestFireAtOrBefore` for `everyHour` and `at` (weekday skip over weekends, `everyday`, a DST transition date, 09:30 ET in both EST and EDT)
  - invalid `when` rejected
  - tick: an hourly task fires at :00, not again at :15, catches up once at :15 if :00 was missed; a new task doesn't fire for a past slot; the 09:30 ET task fires on the 09:30 tick on a weekday and not on Saturday; two concurrent ticks claim a task once; a failing task is reported and doesn't stop others
- `test/core/http.test.ts`: `/healthz` returns `{ env, version }`; unknown path 404; wrong method 405.
- `test/core/app.test.ts`: enabled feature registers jobs/tasks under its id; disabled feature's `register` isn't called; a feature's thrown scheduled task doesn't break another feature; core prune task deletes deliveries older than 7 days; invalid config makes the worker entry return 500; the worker entry's queue handler routes DLQ batches to the drain path.
