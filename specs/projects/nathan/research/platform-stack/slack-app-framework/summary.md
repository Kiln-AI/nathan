# Slack App Framework (TypeScript on Cloudflare Workers)

## Bottom Line

Use **`slack-cloudflare-workers`**, a thin Workers wrapper over the community framework **`slack-edge`**. It is the only maintained Slack framework built for Workers:
- web-standard `Request`/`Response`, Web Crypto signature checks, and a fetch-based typed client
- no `nodejs_compat` needed
- built-in ack/lazy handlers that map directly onto `ctx.waitUntil`

Official **Bolt for JS has no Workers support**. As of Bolt 5.1 / `@slack/web-api` 8.x (fetch-based since July 2026), Bolt *can* run in workerd, but only with `nodejs_compat`, a hand-written receiver and a fetch wrapper that works around two workerd incompatibilities. This was verified locally. The bundle is also 14× larger. The cost of slack-edge is a bus factor of one or two community maintainers, outside Slack. Contain it with a thin `SlackGateway` adapter so features never import the framework directly.

Every Slack feature Nathan's UX needs exists and fits Workers:
- global shortcut + modal with inline errors
- `chat.update` live cards, threaded @mention replies, App Home, slash command
- `users.info` IANA time zone

**Global shortcut + modal** is the right primary "Request PR" entry. A Workflow Builder form + custom step can't do inline validation or a conditional draft checkbox, and needs a paid plan plus an org-ready app.

## Key Findings

- **Bolt JS ships no fetch/edge receiver.** Only HTTP/Express/Lambda/Socket Mode receivers exist, and `App.ts` eagerly imports the Node HTTP and Socket Mode receivers. Bolt JS has **no lazy listeners**; that's a Bolt-Python feature. Its serverless guidance is `processBeforeResponse: true`, which holds the ack until work finishes. See [framework-comparison.md §1](./framework-comparison.md#1-bolt-for-js-on-workers) and the [bolt-js repo v5.1.0](https://github.com/slackapi/bolt-js).
- **Bolt 5.1 in local workerd: works only with shims.** The `WebClient` failed with `Illegal invocation`: it calls `this.fetchFn(...)` with unbound `globalThis.fetch`. With a bound fetch it then failed with `Invalid redirect value`, because it passes `redirect: 'error'`, which workerd rejects. It worked with `clientOptions.fetch: (u,i) => fetch(u,{...i, redirect:'manual'})`. Bundle: 2.86 MB raw / 629 KB gzip, vs 199 KB / 31 KB for slack-edge. See [framework-comparison.md §1.2](./framework-comparison.md#12-empirical-test-bolt-51-in-local-workerd-wrangler-dev-compat-date-2026-09-01) and [web-api 8.0 changelog](https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/CHANGELOG.md).
- **slack-edge / slack-cloudflare-workers verified in local workerd.** Shortcut acked in ~20 ms while the lazy handler ran 4 s more via `waitUntil`. A bad signature got 401. Modal `response_action: errors` was returned inline. Strict TS rejected a malformed ack type. Versions: slack-edge 1.3.17 (2026-05), slack-cloudflare-workers 1.3.10 (2026-05; deps bumped 2026-09). See [framework-comparison.md §2](./framework-comparison.md#2-slack-edge--slack-cloudflare-workers) and [slack-edge repo](https://github.com/slack-edge/slack-edge).
- **slack-edge maintenance.** Author Kazuhiro Sera (211 commits) wrote most of Bolt at Slack and is now at OpenAI. Since 2026 a second maintainer (Stephen Cook, 36 commits) cuts releases. 152★ / 131★ with very few open issues. The source is small (about 7.8k lines, mostly types), so it's forkable if abandoned ([framework-comparison.md §2.2](./framework-comparison.md#22-maintenance-and-maturity)).
- **slack-edge gotchas.**
  - (1) The default single-workspace `authorize` calls `auth.test` on **every request** before the ack. Supply a cached `authorize`.
  - (2) By default lazy runs *in parallel with* ack, so a `view_submission` lazy runs even when the ack returned validation errors. Re-check inside lazy.
  - (3) `trigger_id` expires in 3 s, so open the modal in the ack path ([framework-comparison.md §2.4](./framework-comparison.md#24-gotchas-found-in-the-source--test)).
- **Workers lifetime.** `ctx.waitUntil` extends a request by **≤30 s** after the response, with no durability or retry. Use Queues (at-least-once, 3 retries + DLQ, `delaySeconds` ≤24 h, available on the Free plan) for work that must not be dropped and for the 60 s debounce/coalesce windows ([workers-ack-pattern.md](./workers-ack-pattern.md), [CF limits](https://developers.cloudflare.com/workers/platform/limits/), [Queues](https://developers.cloudflare.com/queues/configuration/batching-retries/)).
- **Modal validation must finish within the 3 s ack.** Errors can only be returned in the ack body (`{"response_action":"errors","errors":{block_id: msg}}`), and Nathan's rules need a GitHub call. Budget about 2–2.5 s with a hard timeout. Use `dispatch_action` on the PR-URL input plus `views.update` to add the "Mark ready for review" checkbox only for drafts ([Modals](https://docs.slack.dev/surfaces/modals), [Input block](https://docs.slack.dev/reference/block-kit/blocks/input-block)).
- **Shortcut vs Workflow Builder.**
  - A global shortcut has no URL, so it can't be a bookmark. Only a workflow link trigger can.
  - Custom steps need a paid plan, an org-ready app (`org_deploy_enabled`) installed at org level, the `function_executed` event, and `complete`/`fail` calls. Billing for custom-step workflows ended 2024-09-25.
  - A WB form loses inline validation.
  - Opening *our* modal from a WB link trigger via an `interactivity` input is documented for Deno but **unverified for Bolt/HTTP apps**.
  - Recommendation: shortcut + modal, with a bookmarkable alternative via an App Home button or a pinned message with a button ([slack-platform-features.md §1](./slack-platform-features.md#1-request-pr-entry-point-shortcut--modal-vs-workflow-builder-custom-step)).
- **Live cards and mentions.**
  - `chat.update` is Tier 3 (50+/min per workspace).
  - `chat.postMessage` is roughly 1 msg/s **per channel**, and all of `#prs` shares it.
  - Mentions use `<@U…>` and notify only in *new* messages: edits don't re-notify. That validates handoffs as new threaded replies ([chat.update](https://docs.slack.dev/reference/methods/chat.update), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage), [Formatting](https://docs.slack.dev/messaging/formatting-message-text)).
- **App Home and slash command.**
  - App Home: `views.publish` (no scope, Tier 4) on `app_home_opened`.
  - Slash command: `/nathan prs` acks with ephemeral text, then uses `response_url` (≤5 posts in 30 min) ([App Home](https://docs.slack.dev/surfaces/app-home), [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction)).
- **Time zone.** `users.info` (`users:read`, Tier 4) returns IANA `tz`, `tz_label` and `tz_offset`. Use `tz` for weekend math ([users.info](https://docs.slack.dev/reference/methods/users.info)).
- **Minimum bot scopes:** `commands`, `chat:write`, `users:read`, `reactions:write`, `im:write`. Optional: `chat:write.public` and `bookmarks:write` ([slack-platform-features.md](./slack-platform-features.md#required-bot-scopes-minimum-for-the-spec)).
- **Signature verification.** HMAC-SHA256 over `v0:{ts}:{raw body}`, with a ±5 min timestamp window and constant-time compare. slack-edge does this with Web Crypto. It only rejects *old* timestamps, not future ones (minor). Reject an empty signing secret at boot ([Verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack)).

## Details

- [framework-comparison.md](./framework-comparison.md): Bolt vs slack-edge on Workers. Source analysis, both local workerd experiments with results, bundle sizes, maintenance, typing, testability. Read this to choose or justify the framework.
- [workers-ack-pattern.md](./workers-ack-pattern.md): 3-second rules (interactivity, events, trigger_id, view_submission), Workers `waitUntil`/Queues/cron limits, and per-flow patterns for Nathan (shortcut, dynamic draft checkbox, submit, webhooks, sweep). Read this when designing request handling.
- [slack-platform-features.md](./slack-platform-features.md): shortcut vs Workflow Builder custom step vs bookmark; `chat.update`, threads/mentions, DMs, App Home, slash command, `users.info` tz, signature verification, rate-limit table, minimum scopes. Read this when writing the manifest and Slack client.

## Open Questions / Gaps

- **WB link trigger → Bolt/HTTP custom step → `views.open` via `interactivity_pointer`.** Documented only for the Deno SDK. A 2023 bolt-js issue said it was unsupported, and no current Bolt sample was found. Needs a short prototype if a bookmark that opens Nathan's own modal is wanted.
- **Custom steps in a standalone (non-Enterprise) workspace.** The docs say "install at the organization level" and that distribution "works differently" for standalone workspaces. The fetched excerpts didn't spell out the standalone case.
- **Bolt startup CPU on Workers** (1 s limit) not measured. `wrangler check startup` needs Cloudflare network access, which the sandbox blocked. All tests ran in **local** workerd via `wrangler dev`, not a deployed Worker.
- **npm download counts** not obtained (api.npmjs.org blocked).
- **Rate tiers.** `users.info` (Tier 4) and `reactions.add` (Tier 3) come from search-result snippets of the official pages; the extracted page text omitted the Facts box. The `views.update` tier was not checked.
- **Edited mentions don't notify.** The source is a third-party support article, not Slack docs.
- **Outbound-fetch mocking** in Cloudflare's Vitest integration not researched.

## Sources

- [slackapi/bolt-js](https://github.com/slackapi/bolt-js): source/docs/CHANGELOG at v5.1.0 (2026-09-02)
- [node-slack-sdk web-api CHANGELOG](https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/CHANGELOG.md): 8.0.0 fetch migration (2026-07-14), 8.2.0 (2026-09-30)
- [slack-edge/slack-edge](https://github.com/slack-edge/slack-edge): v1.3.17 (2026-05-14) source and README
- [slack-edge/slack-cloudflare-workers](https://github.com/slack-edge/slack-cloudflare-workers): v1.3.10 (2026-05-14) source and docs
- [bolt-js#1803](https://github.com/slackapi/bolt-js/issues/1803), [node-slack-sdk#1335](https://github.com/slackapi/node-slack-sdk/issues/1335), [bolt-js#1984](https://github.com/slackapi/bolt-js/issues/1984): Workers / custom-step-modal issues
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Context](https://developers.cloudflare.com/workers/runtime-apis/context/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Queues batching & retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/): current as of 2026-10-01
- Slack docs (docs.slack.dev, fetched 2026-10-01): [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction), [Events API](https://docs.slack.dev/apis/events-api/), [Modals](https://docs.slack.dev/surfaces/modals), [Implementing shortcuts](https://docs.slack.dev/interactivity/implementing-shortcuts), [Workflow steps](https://docs.slack.dev/workflows/workflow-steps), [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits), [App Home](https://docs.slack.dev/surfaces/app-home), [Verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack), and the method reference pages linked in the deep docs
- [Slack updates and changes](https://slack.com/help/articles/115004846068-Slack-updates-and-changes): workflow billing change, 2024-09-25
- [Slack plans and features](https://slack.com/help/articles/115003205446-Slack-plans-and-features): Workflow Builder and custom steps by plan
