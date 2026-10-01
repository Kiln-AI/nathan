# Webhooks for the PR State Model

Source: webhook definitions in [github/docs](https://github.com/github/docs) `src/webhooks/data/fpt/*.json` (the data behind [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)), plus `content/webhooks/using-webhooks/*.md`. Read 2026-10-01.

Spec §5 makes webhooks an *optimization*: "state is always recomputed from GitHub". So each event only needs to tell Nathan **which PR to recompute** (plus the debounce triggers in §4.3B). It doesn't need to carry the state itself.

## 1. Events to subscribe to

| Event | Actions that matter | Permission needed to subscribe (verbatim) | Why Nathan needs it |
|---|---|---|---|
| `pull_request` | `opened`, `reopened`, `closed` (merged if `pull_request.merged`), `converted_to_draft`, `ready_for_review`, `review_requested`, `review_request_removed`, `synchronize`, `edited` (base change), `enqueued`/`dequeued` (if merge queue is used) | "at least read-level access for the "Pull requests" repository permission" | Rules 1–3, 6, the card, GitHub-originated threads (§4.3B with 1-minute debounce), and resets on push (`synchronize`) |
| `pull_request_review` | `submitted`, `dismissed`, `edited` | Pull requests read | Rules 7–9 and handoffs ("Alex approved") |
| `check_run` | `completed` (also `created` for "running") | "at least read-level access for the "Checks" repository permission. To receive the `rerequested` and `requested_action` event types, the app must have at least write-level access" | Rule 5. Gives per-job granularity, so "CI failing" can fire as soon as one required job fails |
| `check_suite` | `completed` | Checks read | Optional and coarser (one suite per Actions workflow run). `check_run` makes it redundant |
| `status` | (no actions) | "at least read-level access for the "Commit statuses" repository permission" | Rule 5 for legacy commit-status CI (external CI services) |
| `installation`, `installation_repositories` | all | "All GitHub Apps receive this event by default. You cannot manually subscribe to this event." | Detect uninstall / repo access changes |

**Not needed or not recommended:**
- `pull_request_review_comment`, `pull_request_review_thread`: don't change any §4.2 rule.
- `issue_comment`: no rule depends on it.
- `branch_protection_rule`, `branch_protection_configuration`, `repository_ruleset`: each requires **Administration read**. They'd only invalidate a required-checks cache; the hourly sweep covers that.
- `member`/`organization`: need **Members read**. Not needed if team membership comes from Nathan's user directory.
- `merge_group`: App-only, needs "Merge queues" permission. Only relevant if repos use merge queues.

Full `pull_request` action list in the current docs: `assigned, auto_merge_disabled, auto_merge_enabled, closed, converted_to_draft, demilestoned, dequeued, edited, enqueued, labeled, locked, milestoned, opened, ready_for_review, reopened, review_request_removed, review_requested, stacked, synchronize, unassigned, unlabeled, unlocked`. `stacked` is new ("A pull request was added to a stack"). Docs best practice (verbatim): "GitHub continues to add new event types and new actions to existing event types. Your application should check the event type and action of a webhook payload before processing the payload."

## 2. Mapping check and status events back to PRs (fork PRs!)

The `check_run` and `check_suite` docs say (verbatim): "The API only looks for pushes in the repository where the check run was created. Pushes to a branch in a forked repository are not detected and return an empty `pull_requests` array and a null value for `head_branch`."

`status` payloads carry a `sha`, not a PR.

**[inference]** OSS PRs come from forks, so check and status events for them can't be mapped through `pull_requests[]`. Nathan should keep a `head_sha → (repo, PR number)` index (updated on `pull_request` opened/synchronize/reopened and by the sweep), and look up `check_run.head_sha` / `status.sha` in it. Unknown SHAs can be ignored; the hourly sweep is the backstop.

## 3. Delivery semantics that shape the handler

Verbatim from the docs:
- "Your server should respond with a 2XX response within 10 seconds of receiving a webhook delivery. If your server takes longer than that to respond, then GitHub terminates the connection and considers the delivery a failure."
- "you may want to set up a queue to process webhook payloads asynchronously. Your server can respond when it receives the webhook, and then process the payload in the background"
- "GitHub does not automatically redeliver failed deliveries." (`handling-failed-webhook-deliveries.md`). Apps can redeliver through the API; there's a doc page "Automatically redelivering failed deliveries for a GitHub App webhook".
- "you can use the `X-GitHub-Delivery` header to ensure that each delivery is unique per event." "If you request a redelivery, the `X-GitHub-Delivery` header will be the same as in the original delivery."

**[inference] Workers design:** verify the signature, then hand the PR key to `ctx.waitUntil()` or a Queue (or a Durable Object for the 60s coalescing and 1-min debounce), and return `202` immediately. Since state is recomputed, dedup on `X-GitHub-Delivery` is nice-to-have, not required. The hourly sweep covers missed deliveries, so automatic redelivery isn't needed.

## 4. Signature verification

Verbatim from "Validating webhook deliveries":
- "The hash signature will appear in each delivery as the value of the `X-Hub-Signature-256` header."
- "GitHub uses an HMAC hex digest to compute the hash." "The hash signature always starts with `sha256=`." "The hash signature is generated using your webhook's secret token and the payload contents."
- "If your language and server implementation specifies a character encoding, ensure that you handle the payload as UTF-8."
- "Never use a plain `==` operator. Instead consider using a method like `secure_compare` or `crypto.timingSafeEqual`."
- Test vector: secret `It's a Secret to Everybody`, payload `Hello, World!` → `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`.

The docs' own JavaScript example uses Web Crypto: `crypto.subtle.importKey("raw", secretBytes, {name:"HMAC", hash:{name:"SHA-256"}}, false, ["sign","verify"])`, then `crypto.subtle.verify("HMAC", key, sigBytes, dataBytes)`. `subtle.verify` does the comparison internally, so no manual string compare is needed. This runs as-is on Workers. Cloudflare also exposes a non-standard `crypto.subtle.timingSafeEqual(a, b)` ([Workers Web Crypto docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)).

**Must verify against the raw body:** read `await request.text()` *before* any JSON parse, and verify those exact bytes as a string. Re-serializing parsed JSON changes the bytes.

`@octokit/webhooks-methods` `verify(secret, payloadString, signatureHeader)` implements exactly this with `crypto.subtle.verify` (`src/web.ts`). Its `package.json` `exports` maps the `browser` condition to `dist-web`, which Wrangler selects (see [workers-libraries.md](./workers-libraries.md)). **Verified in workerd 2026-10-01:** it reproduces the docs' test vector (`sign` → `sha256=757107ea…`, `verify` → `true`, and `false` with the wrong secret).
