# Fetching Data for the PR State Model (spec §4.2)

Primary source: the GitHub GraphQL public schema (`src/graphql/data/fpt/schema.docs.graphql` in [github/docs](https://github.com/github/docs), read 2026-10-01) and the REST endpoint data in the same repo. Third-party reports are labelled **[community report]**. My own conclusions are labelled **[inference]**.

## 1. Mapping each rule to API fields

| # | Rule | GraphQL field(s) | Notes |
|---|---|---|---|
| 1 | Merged | `PullRequest.merged`, `mergedAt`, `state == MERGED` | |
| 2 | Closed unmerged | `state == CLOSED` | |
| 3 | Draft | `isDraft: Boolean!` | Don't use `mergeStateStatus == DRAFT`. It is deprecated: "DRAFT state will be removed from this enum and `isDraft` should be used instead" |
| 4 | Merge conflict | `mergeable: MergeableState!` = `CONFLICTING` | Values: `CONFLICTING` "cannot be merged due to merge conflicts", `MERGEABLE`, `UNKNOWN` "still being calculated". Treat `UNKNOWN` as "no conflict" for now; the next sweep or webhook settles it |
| 5 | Required CI failing | `commits(last:1){nodes{commit{statusCheckRollup{contexts{... on CheckRun{name status conclusion isRequired(pullRequestNumber:N)} ... on StatusContext{context state isRequired(pullRequestNumber:N)}}}}}}` | See §2. Failing = CheckRun `conclusion ∈ {FAILURE, TIMED_OUT, CANCELLED?, STARTUP_FAILURE, ACTION_REQUIRED}` or StatusContext `state ∈ {FAILURE, ERROR}`. Pending/queued/in-progress is not failing (spec) |
| 6 | Pending requested reviewer | `reviewRequests(first:N){nodes{requestedReviewer{__typename ... on User{login}}}}` | `RequestedReviewer = Bot \| EnterpriseTeam \| Mannequin \| Team \| User`. Ignore `Team`/`EnterpriseTeam` per spec. A reviewer drops out of this list once they submit a review (REST docs: "Once a requested reviewer submits a review, they are no longer considered a requested reviewer") |
| 7 | Latest review = changes requested | `latestOpinionatedReviews(first:N){nodes{author{login} state submittedAt}}` | Schema: "A list of latest reviews per user associated with the pull request." "Opinionated" means it skips COMMENTED reviews when the user has an APPROVED/CHANGES_REQUESTED one **[inference from name + common usage; the schema text doesn't say so]**. Also `writersOnly: Boolean = false` |
| 8 | ≥1 approval | Same as above, `state == APPROVED` | `reviewDecision` (APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED, nullable) reflects branch-protection *requirements*, not "≥1 approval". It is null when no review is required. **Don't use it for rules 7 and 8** |
| 9 | Has reviews, none of the above | `reviews(first:1){totalCount}` or `latestReviews` | |
| 10 | No reviewers, no reviews | empty `reviewRequests` and zero reviews | |
| — | Author | `author{login}`, `authorAssociation` | `author` is an `Actor`. Bots show as `dependabot` with `__typename: Bot` in GraphQL; REST shows `dependabot[bot]` **[inference: matching on login must handle both forms]** |
| — | Draft age | `createdAt` and `timelineItems(itemTypes:[CONVERT_TO_DRAFT_EVENT, READY_FOR_REVIEW_EVENT], last: N)` | Both event types have `createdAt: DateTime!` and `actor` |
| — | Card fields | `title url number additions deletions createdAt` | |

`PullRequestReviewState` values: `APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING`. Exclude `PENDING` (unsubmitted). A `DISMISSED` review no longer counts for 7 or 8.

## 2. "Which checks are required?": three options

### Option A (recommended): GraphQL `isRequired`

Schema (verbatim), on both `CheckRun` and `StatusContext` (interface `RequirableByPullRequest`):

```graphql
"Whether this is required to pass before merging for a specific pull request."
isRequired(pullRequestId: ID, pullRequestNumber: Int): Boolean!
```

- Added 2021-03-18. The `pullRequestNumber` argument was added 2021-03-21 (GraphQL changelog in github/docs).
- The GitHub CLI's `gh pr checks --required` uses exactly this: `isRequired(pullRequestId: ...)` inside `statusCheckRollup.contexts` (`api/query_builder.go`, `RequiredStatusCheckRollupGraphQL`, [cli/cli trunk](https://github.com/cli/cli/blob/trunk/api/query_builder.go)).
- **[community report]** It "resolves classic branch protection and rulesets together and needs only ordinary repository read access". When the argument is omitted, the canned `gh --json statusCheckRollup` query "reports null for all eleven checks" versus "three required and eight not" with the argument ([gkalyan/firstmate#2](https://github.com/gkalyan/firstmate/pull/2), referencing [cli/cli#14475](https://github.com/cli/cli/pull/14475), Sept 2026).
- **Catch for bulk queries:** the argument is per PR, and GraphQL can't pass a parent's `number` into a nested field argument. So `isRequired` can't be asked in the generic "all open PRs" list query. **[inference]** Workable pattern: after the list query, generate one aliased query covering only the PRs whose rollup has a failing context:

```graphql
query RequiredForFailing {
  p_repo1_123: repository(owner:"org", name:"repo1") { pullRequest(number:123) { ...Req123 } }
  # ...one alias per PR that has a failing context
}
# fragments can't take args either: inline the number per alias when generating the query string
```

Usually zero or a handful of PRs need this, so the sweep costs 1–2 GraphQL calls.

### Option B: rulesets REST plus GraphQL `refUpdateRule` (no Administration permission)

- `GET /repos/{o}/{r}/rules/branches/{base}` (**Metadata: read**) returns active rules, including any `required_status_checks` rule (its `parameters.required_status_checks[].context`). This covers repo- and org-level rulesets, but **not classic branch protection**.
- GraphQL `Ref.refUpdateRule` is "Branch protection rules that are viewable by non-admins". It has `requiredStatusCheckContexts: [String]` for classic protection. **[inference]** Use `repository{ ref(qualifiedName:"refs/heads/main"){ refUpdateRule{ requiredStatusCheckContexts } } }`.
- Then match check names/contexts against the union. This is per base branch (cache it per sweep), not per PR. Drawbacks: name matching is brittle (rulesets can pin an `integration_id`; check names include matrix suffixes), and you implement GitHub's logic yourself.

### Option C: classic branch-protection REST (Administration: read). Not recommended.

`GET /repos/{o}/{r}/branches/{b}/protection/required_status_checks` needs **Administration: read**, a broad permission for a bot. It also misses rulesets.

### What about `mergeStateStatus`? It's a cheap hint, not a substitute.

Enum `MergeStateStatus` (verbatim descriptions): `BEHIND` "The head ref is out of date." `BLOCKED` "The merge is blocked." `CLEAN` "Mergeable and passing commit status." `DIRTY` "The merge commit cannot be cleanly created." `DRAFT` (deprecated). `HAS_HOOKS` "Mergeable with passing commit status and pre-receive hooks." `UNKNOWN` "The state cannot currently be determined." `UNSTABLE` "Mergeable with non-passing commit status."

- **[inference]** `UNSTABLE` ≈ "only non-required checks are failing or pending". `BLOCKED` mixes failing *required* checks with missing *required reviews* and other rules, so it can't tell rule 5 apart from "needs approval". `DIRTY` ≈ conflict (same signal as `mergeable == CONFLICTING`).
- **Use it as a shortcut only:** `CLEAN`/`HAS_HOOKS`/`UNSTABLE` imply no required check is failing, so `isRequired` can be skipped for that PR. On `BLOCKED` with a failing context, resolve via Option A.
- Field history: originally behind the `merge-info-preview` schema preview. It is now in the GA schema and `previews.json` is empty.

### Lazy mergeability (affects rule 4)

- REST docs (verbatim, `GET /pulls/{pull_number}`): "The value of the mergeable attribute can be true, false, or null. If the value is null, then GitHub has started a background job to compute the mergeability. After giving the job time to complete, resubmit the request."
- The docs guide "Checking mergeability of pull requests" says a test merge commit is created when you "get, create, or edit a pull request using the REST API". It recommends: receive the webhook, call `GET /pulls/{n}` to start the job, then poll.
- **[community report]** In GraphQL, mergeability is also lazy. Only selecting **`mergeable`** triggers the computation, not `mergeStateStatus` alone. One measurement on 46 open PRs: "UNKNOWN=40 from the query without the field, a decided `mergeable` value for all 46 from the query with it" ([rjmurillo/ai-agents#5463](https://github.com/rjmurillo/ai-agents/pull/5463)). **Always select `mergeable`** and treat `UNKNOWN` as "not yet known; keep the previous state".
- The REST *list* endpoint (`GET /pulls`) response schema has **no** `mergeable`/`mergeable_state` fields; only the single-PR GET has them (from `pulls.json` schemas). That's one reason REST fan-out costs more calls.

### Rollup gotcha: compute check state yourself

**[community report]** `statusCheckRollup.state` can differ depending on whether `contexts` is selected in the same query. On one Next.js commit: "SUCCESS" without contexts, "FAILURE" with `contexts(first:1)`. That commit had a check name with both SUCCESS and FAILURE runs, and the result was "not a race" ([pvcnt/mergeable#189](https://github.com/pvcnt/mergeable/issues/189), 2026-09-16). **[inference]** Derive failing/pending from `contexts` yourself and dedupe re-runs: keep the latest run per check name, using `completedAt`/`startedAt`. Use `contexts(first:100)` and page when `hasNextPage`.

## 3. Hourly sweep: one GraphQL query vs REST fan-out

### Recommended query shape (one request for all repos)

```graphql
query Sweep($cursor0: String) {
  r0: repository(owner: "org", name: "repo-a") { ...OpenPRs }
  r1: repository(owner: "org", name: "repo-b") { ...OpenPRs }
  # one alias per configured repo
  rateLimit { cost remaining resetAt }
}

fragment OpenPRs on Repository {
  nameWithOwner
  pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: ASC}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id number title url isDraft createdAt additions deletions baseRefName
      author { __typename login } authorAssociation
      mergeable mergeStateStatus
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
      latestOpinionatedReviews(first: 30) { nodes { state submittedAt author { login } } }
      reviews(first: 1) { totalCount }
      timelineItems(last: 5, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) {
        nodes { __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt } }
      }
      commits(last: 1) { nodes { commit { oid statusCheckRollup {
        contexts(first: 100) { pageInfo { hasNextPage }
          nodes { __typename
            ... on CheckRun { name status conclusion startedAt completedAt }
            ... on StatusContext { context state createdAt }
          } } } } } }
    }
  }
}
```

**Point cost (formula from the GraphQL rate-limit doc):** add up the requests needed per connection, assuming every `first`/`last` is filled, then divide by 100. Per repo that is 1 (pullRequests) + 50 × (reviewRequests 1 + latestOpinionatedReviews 1 + reviews 1 + timelineItems 1 + commits 1 + contexts 1) = 301. For 6 repos that is ≈1,806 requests, or **≈18 points/run, ≈430 points/day**, against a 5,000 points/hour budget. **[inference: computed from the published formula; not executed against the API.]** Query `rateLimit { cost }` to measure the real cost. Node limit: `first`/`last` must be 1–100 and a call can't exceed 500,000 nodes. This query is far below that.

**Why `repository.pullRequests` rather than `search`:** `search(type: ISSUE, query: "is:pr is:open repo:a repo:b")` can cover all repos in one connection and caps at 1,000 results. But the `SearchType` enum has been churning: `ISSUE_ADVANCED` was added and then scheduled for removal 2025-09-04 → 2025-11-04, and `ISSUE_HYBRID`/`ISSUE_SEMANTIC` appeared since. The search index is also eventually consistent **[inference]**. Repository connections are exact and stable.

**Resource limits:** GraphQL requests taking more than 10 seconds are terminated (502/504), and over-heavy queries return partial results plus an error ("Other resource limits" section). **[inference]** If a sweep times out, split it into one query per repo; it is still only a handful of requests.

### REST fan-out for comparison

Per repo: `GET /pulls?state=open` (1). Per PR: `GET /pulls/{n}` (needed for `mergeable`), `GET .../reviews`, `GET .../requested_reviewers`, `GET /commits/{sha}/check-runs`, `GET /commits/{sha}/status`, `GET .../timeline` for draft times, plus a required-checks lookup per base branch. That's ≈6 calls per PR. 40 open PRs ≈ 250 requests/hour, out of 5,000/hour. It's affordable but slower (sequential latency inside a Worker's cron invocation), it adds subrequest volume, and it still has no per-PR "required" answer without Administration read. **Verdict: GraphQL**, with REST only for the writes (request/remove reviewers) and for webhook-triggered single-PR refreshes if you prefer.

**[inference] Workers note:** the sweep runs in a Cron Trigger. Each `fetch` to api.github.com is a subrequest, and the per-invocation subrequest limits are a hosting concern for another subtopic. The GraphQL approach keeps the count at roughly 2–5 per sweep.

## 4. Rate limits for a GitHub App installation (verbatim from docs source)

**REST primary:** "GitHub Apps authenticating with an installation access token use the installation's minimum rate limit of 5,000 requests per hour. If the installation is on a GitHub Enterprise Cloud organization ..., the installation has a rate limit of 15,000 requests per hour. For installations that are not on a GitHub Enterprise Cloud organization ..., the rate limit for the installation will scale with the number of users and repositories. Installations that have more than 20 repositories receive another 50 requests per hour for each repository. Installations that are on an organization that have more than 20 users receive another 50 requests per hour for each user. The rate limit cannot increase beyond 12,500 requests per hour."

**GraphQL primary:** "For GitHub App installations not on a GitHub Enterprise Cloud organization ...: 5,000 points per hour per installation" (same +50/repo and +50/user above 20, max 12,500). "For GitHub App installations on a GitHub Enterprise Cloud organization ...: 10,000 points per hour per installation."

**Secondary (shared REST + GraphQL):**
- "No more than 100 concurrent requests are allowed."
- "No more than 900 points per minute are allowed for REST API endpoints, and no more than 2,000 points per minute are allowed for the GraphQL API endpoint." Points: GraphQL query 1, GraphQL mutation 5, REST GET 1, REST POST/PATCH/PUT/DELETE 5.
- "No more than 90 seconds of CPU time per 60 seconds of real time ... No more than 60 seconds of this CPU time may be for the GraphQL API."
- "In general, no more than 80 content-generating requests per minute and no more than 500 content-generating requests per hour are allowed."
- "No more than 2,000 OAuth access token requests per hour are allowed for GitHub Apps and OAuth Apps." **[inference]** This plausibly covers installation-token minting too, so cache installation tokens rather than minting one per webhook.

**Exceeding limits:** REST returns `403`/`429` with `x-ratelimit-remaining: 0`, and you must wait until `x-ratelimit-reset`. For secondary limits, honor `retry-after`, else wait ≥1 minute, with exponential backoff. GraphQL primary-limit exhaustion "will still be `200`" with an error message. The GraphQL doc also advises: "pause at least 1 second between mutative requests and avoid concurrent requests."

**[inference]** At Nathan's scale (handful of repos, ~5–15 people), the budget is effectively unlimited. The only real risk is the secondary content-creation limit on reviewer requests, which is irrelevant at human pace.
