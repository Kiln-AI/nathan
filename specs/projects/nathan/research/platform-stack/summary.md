# Research: Platform Stack for Nathan (TypeScript on Cloudflare Workers)

## Bottom Line

Hosting (Cloudflare Workers) and language (TypeScript) were already decided. This research picks the libraries and confirms that the platforms support Nathan's spec.

- **Slack:** use **`slack-cloudflare-workers`** (a thin wrapper over the community framework **`slack-edge`**). It is the only maintained Slack framework built for Workers. Official Bolt for JS has no Workers support. It only runs there with `nodejs_compat`, a hand-written receiver and a fetch shim, and its bundle is 14× larger.
- **GitHub:** use **`@octokit/core` + `@octokit/auth-app` + `@octokit/webhooks-methods`**. One hard rule: the App private key must be converted to PKCS#8.
- **No Node compatibility layer:** both stacks bundled and ran in local workerd without `nodejs_compat`.
- **Shared request pattern:** both sides use the same ingress pattern. Verify the HMAC signature with Web Crypto, acknowledge quickly, then hand the work to `ctx.waitUntil` or a Queue.
- **GitHub App permissions:** Metadata:read, Pull requests:read+write, Checks:read and Commit statuses:read. No Administration permission is needed, because required checks can be read with GraphQL `isRequired`.
- **Spec features:** every Slack UX feature in the spec is available. GitHub rate limits are not a concern.

The architecture step can proceed now. Two items need short live tests before the App manifest and the "mark ready for review" feature are final:
- whether marking a PR ready for review needs Contents:write
- whether `isRequired` works with an installation token

## Key Findings

- **Slack framework:** `slack-edge` (v1.3.17) and `slack-cloudflare-workers` (v1.3.10) were verified in local workerd:
  - the shortcut was acked in about 20 ms while a lazy handler kept running via `waitUntil`
  - bad signatures were rejected
  - inline modal errors worked

  The risk is maintenance: one or two community maintainers outside Slack, though the code is small enough to fork. Contain it behind a thin `SlackGateway` adapter. ([Slack app framework](./slack-app-framework/summary.md))
- **slack-edge gotchas to design around:**
  - Its default `authorize` calls `auth.test` before every ack, so supply a cached one.
  - Lazy handlers run in parallel with the ack, so a `view_submission` lazy handler runs even when validation failed.
  - A `trigger_id` expires in 3 s, so open the modal in the ack path.

  ([Slack app framework](./slack-app-framework/summary.md))
- **"Request PR" entry point:** use a global shortcut plus a modal. A Workflow Builder form can't do inline validation or a conditional draft checkbox. Custom steps also need a paid plan and an org-ready app. A global shortcut has no URL, so for a bookmarkable entry use an App Home button or a pinned message with a button. ([Slack app framework](./slack-app-framework/summary.md))
- **Slack messaging limits shape the card design:**
  - `chat.postMessage` allows about 1 message/s per channel, and all of `#prs` shares that limit.
  - `chat.update` is Tier 3.
  - `@mentions` notify only in new messages, so handoffs must be new threaded replies, not edits.

  ([Slack app framework](./slack-app-framework/summary.md))
- **Workers execution limits:** `ctx.waitUntil` keeps work running for at most 30 s after the response, with no retry. Queues give at-least-once delivery, retries, a DLQ and `delaySeconds` (useful for the 60 s debounce and coalescing windows), and are on the Free plan. Durable Object alarms are the alternative. ([Slack app framework](./slack-app-framework/summary.md), [GitHub App integration](./github-app-integration/summary.md))
- **Required checks without Administration:** GraphQL `isRequired(pullRequestNumber:)` on check runs and status contexts covers both classic branch protection and rulesets. It is the same mechanism `gh pr checks --required` uses. `mergeStateStatus` can't isolate "required CI failing". `statusCheckRollup.state` is unreliable, so compute status from `contexts`. ([GitHub App integration](./github-app-integration/summary.md))
- **Reviewer writes go through REST, not GraphQL.** REST adds reviewers. GraphQL `requestReviews` replaces the existing set by default. REST also returns 422 for non-collaborators, which is a ready-made validation signal for the modal. ([GitHub App integration](./github-app-integration/summary.md))
- **Ready-for-review:** marking a draft ready is GraphQL-only (`markPullRequestReadyForReview`), and its App permission is undocumented. Unofficial reports say Contents:write may also be required. ([GitHub App integration](./github-app-integration/summary.md))
- **Webhooks and the hourly sweep:**
  - **Events:** subscribe to `pull_request`, `pull_request_review`, `check_run` and `status`.
  - **Fork PRs:** their check events arrive with an empty `pull_requests` array, so keep a `head_sha → PR` index.
  - **No redelivery:** GitHub expects a 2xx within 10 s and does not redeliver failed deliveries, so the hourly sweep is the real backstop.
  - **Sweep query:** the sweep is one aliased GraphQL query, about 18 points against a 5,000 points/hour budget. ([GitHub App integration](./github-app-integration/summary.md))
- **Octokit on Workers:**
  - Wrangler picks the Web Crypto build, which rejects GitHub's PKCS#1 key. Node unit tests won't catch this.
  - Installation tokens are cached in memory per isolate, which is short-lived; KV can back the cache.
  - Skip `@octokit/webhooks`' `createWebMiddleware`, which awaits handlers and doesn't use `waitUntil`.

  ([GitHub App integration](./github-app-integration/summary.md))
- **Trend metrics:** time-to-first-review and time-to-merge come from PR and review timestamps that are readable with Pull requests:read. ([GitHub App integration](./github-app-integration/summary.md))

## Implications

- **One ingress pattern for both endpoints.** Verify the signature, return the ack or a 202, then do the work in `waitUntil` or a Queue. Use a Queue (or a Durable Object) for debounce and coalesce timers. The cron sweep and the daily report run as Cron Triggers. The storage choice among D1, KV and Durable Objects is left to the architecture step. Inputs it needs to account for:
  - the `head_sha → PR` index
  - the Slack↔GitHub user mapping
  - card message IDs
  - an optional KV token cache
- **Modal validation crosses both subtopics.** Inline errors must come back in Slack's 3 s ack, and the validation needs GitHub (PR exists, open, draft state, collaborator status) plus a storage read. The Slack research suggests a hard timeout of about 2–2.5 s. Combining the two subtopics: on a cold isolate, GitHub auth adds a JWT signature and a token-mint request before the real call. That argues for the KV-backed token cache and a cached Slack `authorize`.
- **The conditional "Mark ready for review" checkbox depends on the open permission question.** If Contents:write is required, choose between three options:
  - a down-scoped token for that one call
  - accept the broader permission
  - drop the feature
- **Durability differs by origin.** GitHub-originated work is self-healing, because the sweep recomputes state. User-originated work after a modal submit has no such backstop: requesting reviewers, posting the card and the threaded reply. Per spec §5 ("nothing silently dropped"), that work belongs on a Queue, not bare `waitUntil`.
- **Slack is the tighter rate constraint.** The per-channel `chat.postMessage` limit, not GitHub, is the bottleneck to design around for busy `#prs` moments.

## Conflicts and Uncertainty

- **No disagreement between the subtopics.** They independently reached the same pattern: Web Crypto signature verification, ack quickly, process in `waitUntil` or a Queue.
- **`waitUntil` vs Queue is a judgment call.** The GitHub research leans on the sweep as backstop and treats `waitUntil` as acceptable for webhooks. The Slack research leans toward Queues for anything that must not be dropped. The evidence supports using both, split by origin as described above.
- **Things are moving:**
  - Bolt became fetch-based only recently (`@slack/web-api` 8.x, July 2026), and Workers support may improve.
  - slack-edge's last release was 2026-05; only its dependencies were bumped in 2026-09.
  - GraphQL rollup behavior (`statusCheckRollup.state`) has a 2026 quirk report.
- **Several findings rest on unofficial or secondhand sources:**
  - the ready-for-review permission (community discussion)
  - `isRequired` behavior (third-party reports, user tokens only)
  - edited mentions not notifying (a third-party support article)
  - some Slack rate tiers (search snippets)

## Gaps

- **`markPullRequestReadyForReview` permission:** is Pull requests:write enough? Close with a 5-minute test on a scratch repo using an App token.
- **`isRequired` with an installation token:** never tested with an App token. Close with the same scratch-repo test, which also confirms the two-phase sweep query design.
- **Workflow Builder link trigger opening Nathan's own modal (HTTP or Bolt-style custom step):** documented only for the Deno SDK. Its behavior in standalone (non-Enterprise) workspaces is also unclear. A prototype is only needed if a bookmark that opens Nathan's modal is required.
- **Nothing deployed or called live.** All runtime tests used local `wrangler dev`, with no Slack or GitHub API calls. Not measured:
  - Bolt startup CPU (1 s limit)
  - real GraphQL sweep cost (use `rateLimit { cost }`)
  - npm download counts
  - the `views.update` rate tier
- **Smaller open items:**
  - merge-queue (`merge_group`) handling, which depends on team practice
  - whether `refUpdateRule` covers rulesets (fallback path only)
  - outbound-fetch mocking in Cloudflare's Vitest integration

## Subtopics

- [Slack app framework](./slack-app-framework/summary.md): Bolt vs slack-edge on Workers, the ack-then-process pattern, and the Slack features Nathan's UX needs. Headline: use `slack-cloudflare-workers`/`slack-edge` behind an adapter; a shortcut plus modal beats Workflow Builder; every needed feature exists.
- [GitHub App integration](./github-app-integration/summary.md): minimum App permissions, webhook events, the sweep query, metrics and Octokit on Workers. Headline: four read/write permissions suffice via GraphQL `isRequired` (pending the ready-for-review permission test); use one aliased GraphQL sweep and `@octokit/core` + `auth-app` with a PKCS#8 key.
