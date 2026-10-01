---
status: complete
---

# Phase 3: GitHub gateway

## Overview

Build `src/github/`, the only place that touches `@octokit/*`, and plug it into the platform core. After this phase:

- `services.github` is a `GitHubGateway` with a read-only `reader` and an allow-listed `writer` whose only method is `requestReviewers`
- the GitHub App authenticates with a PKCS#8 key (a PKCS#1 key fails startup with the conversion command), and installation tokens are cached in KV (`gh:installation-token`) and per isolate
- the reader returns normalized `PRData` from three GraphQL queries: the hourly sweep (one aliased query for all repos, paged per repo), a single PR, and recently updated PRs (for metrics); plus a lookup of open PRs by head SHA for fork check events
- "required checks" use the two-phase `isRequired` design: the sweep finds PRs with a failing check, then one aliased query resolves `isRequired(pullRequestNumber:)` for exactly those PRs
- `POST /github/webhooks` verifies `X-Hub-Signature-256`, dedupes on `X-GitHub-Delivery`, extracts the PR key(s) and head SHA, and calls the handlers features registered through `registrar.github.on(event, handler)`
- dry run replaces the writer with a logger

No feature registers webhook handlers yet (pr_management arrives in phase 4); this phase delivers the gateway, its fakes and builders, and the setup docs for the GitHub App.

## Steps

1. **Dependencies and test bindings**
   - Add `@octokit/core`, `@octokit/auth-app`, `@octokit/webhooks-methods`. Error classes from `@octokit/request-error` / `@octokit/graphql` are recognised by shape (`name`, `status`, `errors`), so no extra direct dependencies.
   - `vitest.config.ts`: generate an RSA key pair with `node:crypto` at config time and bind `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM), `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET`, plus `TEST_GITHUB_PUBLIC_KEY` (SPKI PEM, to verify JWTs) and `TEST_GITHUB_PKCS1_KEY` (the same key as PKCS#1). `test/env.d.ts` types them.

2. **`src/github/errors.ts`**
   ```ts
   export class GitHubApiError extends Error { constructor(message: string, readonly status: number) }
   export class RateLimitedError extends RetryAfterError {}               // from core/errors
   export function toGitHubError(error: unknown, now: DateTime): unknown; // maps Octokit errors, passes others through
   ```
   - REST `RequestError` (`name === "HttpError"`): 403/429 with `retry-after` → `RateLimitedError(retryAfter)`; with `x-ratelimit-remaining: 0` → `RateLimitedError(reset − now, min 1s)`; else `GitHubApiError(message, status)`.
   - GraphQL `GraphqlResponseError`: any error of type `RATE_LIMITED` → `RateLimitedError` (reset header, else 60s); otherwise `GitHubApiError(message, 200)`.

3. **`src/github/auth.ts`**
   ```ts
   export interface GitHubAppCredentials { appId: string; privateKey: string; installationId: number; webhookSecret: string }
   export function readGitHubAppCredentials(env: object): GitHubAppCredentials;  // throws at startup
   export function assertPkcs8PrivateKey(pem: string): string;                    // unescapes "\n", returns the PEM
   export const TOKEN_CACHE_KEY = "gh:installation-token";
   export const TOKEN_REFRESH_MARGIN_MINUTES = 5;
   export interface InstallationTokens { get(): Promise<string>; invalidate(): Promise<void> }
   export function createInstallationTokens(deps: { credentials; kv: KVNamespace; clock: Clock; request: <octokit request> }): InstallationTokens;
   ```
   - Credentials: all four secrets via `requireSecret`; app ID and installation ID must be positive integers; the key must be PKCS#8 (`BEGIN PRIVATE KEY`). `BEGIN RSA PRIVATE KEY` throws naming the `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem` conversion; anything else (including encrypted keys) throws "not a PKCS#8 PEM".
   - Tokens: in-memory value if it expires more than 5 minutes from now, else the KV value `{ token, expiresAt }` under the same rule, else mint one with `createAppAuth(...)({ type: "installation", refresh: true })` (refresh bypasses auth-app's own in-memory cache, which would otherwise hand back a token we just invalidated) and store it in KV with `expirationTtl` = seconds until it is no longer reusable (minimum 60, KV's floor). Concurrent `get()` calls in one isolate share one mint. `invalidate()` clears both.

4. **`src/github/client.ts`** (module-private Octokit; never exported from `index.ts`)
   ```ts
   export interface GitHubHttp { graphql: ReadOnlyGraphql; request: Octokit["request"] }
   export type ReadOnlyGraphql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
   export function createGitHubHttp(deps: { tokens: InstallationTokens; clock: Clock; fetch?: typeof fetch }): GitHubHttp;
   export function assertReadOnly(query: string): void;  // rejects any document containing `mutation`
   ```
   - One `Octokit` with `hook.wrap("request")` that sets `authorization: token <installation token>`, invalidates the token on a 401, and maps errors with `toGitHubError`.
   - `graphql` checks `assertReadOnly` before sending. `fetch` is a test seam.

5. **`src/github/types.ts`**: the normalized data features use.
   ```ts
   export type PRState = "open" | "merged" | "closed";
   export type Mergeable = "mergeable" | "conflicting" | "unknown";
   export type CheckOutcome = "success" | "failure" | "pending" | "neutral";
   export interface Check { name: string; source: "check_run" | "status"; outcome: CheckOutcome; required: boolean | null }
   export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed";
   export interface Review { author: string; state: ReviewState; submittedAt: DateTime }
   export interface PRData {
     repo: string; number: number; nodeId: string; title: string; url: string;
     author: string;                 // login; bots as "name[bot]", deleted users "ghost"
     authorIsBot: boolean;
     state: PRState; isDraft: boolean;
     createdAt: DateTime; updatedAt: DateTime; mergedAt: DateTime | null; closedAt: DateTime | null;
     lastReadyForReviewAt: DateTime | null; lastConvertedToDraftAt: DateTime | null;
     additions: number; deletions: number; baseRef: string; headSha: string;
     mergeable: Mergeable;
     pendingReviewers: string[];     // users (and bots) still requested
     pendingTeams: string[];         // team slugs; not expanded (spec §4.2)
     reviews: Review[];              // latest review per reviewer, PENDING excluded
     checks: Check[];                // latest run per check name / status context
     checksTruncated: boolean;       // > 100 contexts on the head commit
   }
   export interface PRHistory { repo; number; title; url; author; authorIsBot; state; isDraft; createdAt; updatedAt; mergedAt; closedAt; lastReadyForReviewAt; reviews: Review[] /* every submitted review, oldest first */ }
   export interface SweepResult { pullRequests: PRData[]; missingRepos: string[]; cost: number }
   export interface GitHubReader {
     openPullRequests(repos: readonly string[]): Promise<SweepResult>;
     pullRequest(repo: string, number: number): Promise<PRData | null>;
     recentPullRequests(repos: readonly string[], since: DateTime): Promise<PRHistory[]>;
     openPullRequestsForCommit(repo: string, sha: string): Promise<number[]>;
   }
   export interface GitHubWriter { requestReviewers(repo: string, number: number, logins: readonly string[]): Promise<void> }
   export interface GitHubGateway { reader: GitHubReader; writer: GitHubWriter }
   ```
   - `Check.required` is `null` only when no check on the PR is failing (the two-phase query skips those PRs). When any check fails, every check's `required` is resolved, so "if none are required, any failing check counts" can be decided.
   - `reviews` merges `latestOpinionatedReviews` (approved / changes requested / dismissed, which a later comment doesn't override) with `latestReviews` (for reviewers who only commented).

6. **`src/github/queries.ts`**: GraphQL documents, all values passed as variables (repo owner/name, PR numbers, cursors).
   - `PR_FIELDS` fragment body: `id number title url state isDraft createdAt updatedAt mergedAt closedAt additions deletions baseRefName headRefOid mergeable author{__typename login} reviewRequests(first:50){nodes{requestedReviewer{__typename ... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Team{slug}}}} latestOpinionatedReviews(first:50){…} latestReviews(first:50){…} timelineItems(last:10, itemTypes:[READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]){…} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{…}}}}}}`, with an optional `isRequired(pullRequestNumber: $var)` on the contexts.
   - `sweepQuery(count)`: `r<i>: repository(owner:$o<i>, name:$n<i>) { nameWithOwner pullRequests(states:OPEN, first:50, after:$c<i>, orderBy:{field:CREATED_AT, direction:ASC}) { pageInfo nodes{...} } }` plus `rateLimit { cost }`.
   - `requiredChecksQuery(count)`: `p<i>: repository(owner:$o<i>, name:$n<i>) { pullRequest(number:$p<i>num) { commits(last:1) … contexts with isRequired(pullRequestNumber:$p<i>num) } }`.
   - `pullRequestQuery`: one PR with `isRequired(pullRequestNumber:$number)` inline (the number is known, so no second phase).
   - `recentQuery(count)`: per repo `pullRequests(first:50, after:$c<i>, orderBy:{field:UPDATED_AT, direction:DESC})` with `reviews(first:100)` and the last `READY_FOR_REVIEW_EVENT`.
   - `openHeadsQuery`: `pullRequests(states:OPEN, first:100, after:$cursor){ nodes { number headRefOid } }`.

7. **`src/github/normalize.ts`**: pure mapping from the raw GraphQL node types to `PRData` / `PRHistory`.
   - `normalizeLogin({ __typename, login })`: bots get a `[bot]` suffix (GraphQL returns `dependabot`, REST and config use `dependabot[bot]`); a null actor is `ghost`.
   - `toChecks(contexts)`: CheckRun not `COMPLETED` → pending; conclusion SUCCESS → success; NEUTRAL/SKIPPED/STALE → neutral; FAILURE/TIMED_OUT/CANCELLED/STARTUP_FAILURE/ACTION_REQUIRED → failure. StatusContext SUCCESS → success; PENDING/EXPECTED → pending; FAILURE/ERROR → failure. Re-runs are deduped per (source, name), keeping the latest (`completedAt ?? startedAt`, a run with neither is newest); `required` is true if any run of that name is required.
   - `toReviews(opinionated, latest)`, `toPendingReviewers(requests)`, timeline → last ready/draft times, `toPRData(repo, node)`, `toPRHistory(repo, node)`.

8. **`src/github/reader.ts`**: `createGitHubReader({ graphql, log })`.
   - `openPullRequests(repos)`: validate `owner/name`; page all repos together (one aliased query per round, only repos with `hasNextPage` continue); a repo whose alias errors with `NOT_FOUND` goes to `missingRepos` (logged at warn) instead of failing the sweep; then, for PRs with any failing check, run `requiredChecksQuery` in chunks of 20 and replace their checks with the `isRequired`-annotated ones. `cost` sums `rateLimit.cost`.
   - `pullRequest(repo, number)`: one query; `NOT_FOUND` → `null`.
   - `recentPullRequests(repos, since)`: page each repo by `UPDATED_AT DESC` until a page's oldest PR is older than `since`; return PRs updated at or after `since`.
   - `openPullRequestsForCommit(repo, sha)`: pages open PRs and returns the numbers whose `headRefOid` is `sha`. Fork PRs' `check_run` events carry no `pull_requests`, and `status` events never do.

9. **`src/github/writer.ts`**
   - `createGitHubWriter(request)`: `requestReviewers(repo, number, logins)` → `POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` with `{ reviewers }`. REST is additive (it never removes anyone), unlike GraphQL `requestReviews`. An empty list is a no-op. This is the only GitHub write.
   - `createDryRunGitHubWriter(log)`: same surface, logs `"dry run: would request reviewers"` and does nothing.

10. **`src/github/gateway.ts`**: `createGitHubGateway({ credentials, kv, clock, log, fetch? })` → `{ reader, writer }`; `withDryRun(gateway, log)` swaps in the dry-run writer.

11. **`src/github/webhooks.ts`**
    ```ts
    export const GITHUB_EVENTS = ["pull_request", "pull_request_review", "check_run", "status"] as const;
    export type GitHubEventName = (typeof GITHUB_EVENTS)[number];
    export interface GitHubWebhookEvent {
      deliveryId: string; name: GitHubEventName; action: string | null;
      sender: string | null;              // login of whoever caused it (bots as "name[bot]")
      repo: string | null;                // "owner/name"
      pullRequests: number[];             // PRs in `repo` this event is about; empty for status and fork check runs
      headSha: string | null;             // the commit (PR head, check run head, status sha)
      payload: unknown;                   // raw payload for anything else
    }
    export type GitHubWebhookHandler = (event: GitHubWebhookEvent) => Promise<void>;
    export interface GitHubRegistry { on(event: GitHubEventName, handler: GitHubWebhookHandler): void }
    export class GitHubHandlers { forFeature(featureId): GitHubRegistry; handlersFor(name) }
    export function parseWebhookEvent(name, deliveryId, payload): GitHubWebhookEvent;
    export function createGitHubWebhookRoute(deps: { secret; handlers; db; clock; reportError; log }): { handle(request): Promise<Response> };
    ```
    - Route: read the raw body; missing or invalid `X-Hub-Signature-256` (`webhooks-methods` `verify`) → 401 with a warn log; missing delivery ID or event header, or a body that isn't a JSON object → 400; `INSERT INTO webhook_deliveries … ON CONFLICT DO NOTHING`, 0 changes → 200 (duplicate); event with no handlers (including `ping` and unsubscribed events) → 202; else run each handler inline through `runIsolated("<featureId>.github:<event>")` and return 202.
    - PR-key extraction: `pull_request` / `pull_request_review` → `pull_request.number`, `pull_request.head.sha`; `check_run` → `check_run.pull_requests[]` whose base repo is this repo, `check_run.head_sha`; `status` → no PRs, `sha`.
    - Registering an unknown event name throws. Several features may register the same event.

12. **`src/github/index.ts`**: the public surface features import: the types above, `GitHubApiError`, `RateLimitedError`, `GitHubRegistry`, `GitHubWebhookEvent`, `GitHubEventName`, `GITHUB_EVENTS`. Core-only constructors (`createGitHubGateway`, `readGitHubAppCredentials`, `GitHubHandlers`, `createGitHubWebhookRoute`) are imported by `src/core/app.ts` from their modules.

13. **Core wiring**
    - `src/core/feature.ts`: `Registrar.github: GitHubRegistry`; `Services.github: GitHubGateway`.
    - `src/core/app.ts`: `readGitHubAppCredentials(env)` at startup (missing secrets or a PKCS#1 key throw); `AppOverrides.github` replaces the gateway (dry-run writer still applies); registrars get `github: githubHandlers.forFeature(id)`; route `POST /github/webhooks`.

14. **Test infrastructure**
    - `test/fakes/github.ts`: `FakeGitHub implements GitHubGateway` over in-memory `PRData` (and `PRHistory`) fixtures; records `requestReviewers` calls and adds the logins to the fixture's `pendingReviewers`; failure injection.
    - `test/builders/github.ts`: `aPR(overrides)`, `aReview(overrides)`, `aCheck(overrides)`, `aPRHistory(overrides)`.
    - `test/helpers/github.ts`: `signedWebhookRequest(event, payload, { deliveryId?, secret? })` (HMAC with Web Crypto) and a `stubGitHubApi(routes)` fetch stub that records calls and answers the token endpoint, `/graphql` and REST routes.
    - `test/fixtures/github/*.json`: recorded-shape GraphQL responses (sweep pages, required checks, single PR, not-found, recent PRs, open heads) and webhook payloads (`pull_request`, `pull_request_review`, `check_run` same-repo and fork, `status`).

15. **`docs/setup.md`**: fill the GitHub App section: create the App per environment (permissions Metadata R, Pull requests R/W, Checks R, Commit statuses R; events `pull_request`, `pull_request_review`, `check_run`, `status`; webhook URL `/github/webhooks` and secret), generate and convert the private key to PKCS#8, install on the tracked repos, and set the four secrets.

## Tests

- `test/github/auth.test.ts`
  - credentials: valid secrets parse; each missing secret fails; non-numeric IDs fail; PKCS#1 key fails with the openssl command; a non-PEM key fails; escaped `\n` keys are unescaped
  - PKCS#8 JWT signing in workerd: the app JWT verifies against the public key, with `iss` = app ID and `exp − iat ≤ 600`; the PKCS#1 key is rejected by the JWT library itself (why the startup check exists)
  - tokens: first `get` mints and stores `{ token, expiresAt }` in KV; a second `get` uses memory (no fetch); a new isolate (fresh token source) uses KV; a token within 5 minutes of expiry is re-minted; concurrent gets mint once; `invalidate` forces a re-mint
- `test/github/errors.test.ts`: REST 403 with `x-ratelimit-remaining: 0` → `RateLimitedError` with the reset delay; 429 with `retry-after`; other statuses → `GitHubApiError`; GraphQL `RATE_LIMITED` → `RateLimitedError`; other GraphQL errors → `GitHubApiError`; non-Octokit errors pass through
- `test/github/client.test.ts`: requests carry the installation token; a 401 invalidates the cached token so the next call mints a new one; `graphql` rejects documents containing `mutation` without sending them
- `test/github/normalize.test.ts`: login normalization (user, bot, null → ghost); every check-run status/conclusion and status state mapping; re-run dedupe (later run wins, queued run wins, required carried over); review merging (opinionated wins over a later comment, comment-only reviewers kept, PENDING dropped); pending reviewers split into users and teams; ready/draft timeline times; merged/closed state mapping
- `test/github/reader.test.ts` (fixtures through the fetch stub)
  - sweep: two repos in one query, normalized `PRData` matching expectations; per-repo pagination continues only repos with more pages and passes the cursor; failing PRs get a second `isRequired` query and their checks are replaced with `required` set; PRs without failures skip it and keep `required: null`; a `NOT_FOUND` repo goes to `missingRepos` while others still return; `cost` sums `rateLimit.cost`; an invalid repo name throws
  - single PR: found (with `isRequired` resolved in one query); not found → `null`
  - recent PRs: stops paging once older than `since`, filters out older PRs, keeps every review
  - open PRs for a commit: returns matching numbers, paging through open PRs
- `test/github/writer.test.ts`: `requestReviewers` POSTs the reviewers to the right route; empty list sends nothing; a 422 surfaces as `GitHubApiError` with the status; dry-run writer logs and sends nothing; the writer's public surface is exactly `{ requestReviewers }`
- `test/github/webhooks.test.ts`
  - `parseWebhookEvent` for each fixture: pull_request (number, head sha, sender, action), review, same-repo check_run, fork check_run (no PRs, head sha), check_run listing a PR from another repo (filtered), status (sha only), malformed fields → empty
  - route via `app.fetch`: valid signature → 202 and the handler gets the parsed event; bad or missing signature → 401 and no handler; missing headers or non-JSON → 400; redelivery of the same delivery ID → 200 and the handler runs once; event with no handlers → 202; a throwing handler is reported with source `<feature>.github:<event>` and other handlers still run (still 202); the GitHub docs test vector verifies
  - registry: unknown event name rejected; two features can handle the same event
- `test/core/app.test.ts` additions: each missing GitHub secret and a PKCS#1 key fail startup; features receive `registrar.github` and `services.github`; dry-run config swaps the writer for a logger even with an injected gateway
- `test/fakes/github` is exercised by the app tests (FakeGitHub as `overrides.github`).
