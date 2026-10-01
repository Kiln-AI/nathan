# Ack-then-process on Cloudflare Workers

How Nathan meets Slack's 3-second acknowledgement on Workers, and where the heavy work goes.

## The constraints

**Slack side:**
- Interactivity (shortcuts, buttons, modal submissions, slash commands): "your app must reply to the HTTP POST request with an HTTP 200 OK response. This must be sent within 3 seconds of receiving the payload. If your app doesn't do that, the Slack user who interacted with the app will see an error message" ([Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction)).
- Events API: "Your app should respond to the event request with an HTTP 2xx within three seconds. If it does not, we'll consider the event delivery attempt failed. After a failure, we'll retry three times, backing off exponentially." Each retry carries `x-slack-retry-num` (1–3) and `x-slack-retry-reason` (e.g. `http_timeout`). If more than 95% of deliveries fail within 60 minutes, "your application's event subscriptions will be temporarily disabled". A `x-slack-no-retry: 1` header on a non-200 response suppresses retries ([Events API](https://docs.slack.dev/apis/events-api/)).
- `trigger_id`: "Triggers expire in three seconds… Triggers may only be used once" ([Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction)).
- `view_submission`: validation errors and view updates can only be returned *in the ack body* ("you have 3 seconds to respond") ([Modals](https://docs.slack.dev/surfaces/modals)).
- `response_url` (slash commands, block actions): "These responses can be sent up to 5 times within 30 minutes of receiving the payload" ([Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction)).

**Workers side** ([Limits](https://developers.cloudflare.com/workers/platform/limits/), [Context](https://developers.cloudflare.com/workers/runtime-apis/context/)):
- "`waitUntil()` can extend execution for up to **30 seconds** after the response is sent or the client disconnects."
- Startup (global scope) must finish within 1 s.
- CPU per HTTP request: Free 10 ms; Paid default 30 s, configurable to 5 min.
- Subrequests: Free 50/request; Paid 10,000.
- Cron Triggers: 15 min wall time. Paid plan CPU is 30 s for intervals under 1 hour, and 15 min for intervals of 1 hour or more.
- Queue consumers: 15 min wall time.

## Three tiers of "after the ack"

| Mechanism | Lifetime | Durability | Use for Nathan |
|---|---|---|---|
| **Inline in ack** | must finish well under 3 s, including Slack's network time | n/a | `views.open` for the shortcut (trigger_id), modal validation that returns `response_action: errors`, ephemeral slash-command text |
| **`ctx.waitUntil`** (= slack-edge "lazy" handler) | ≤30 s after response | **None.** If the isolate dies or work throws, it's gone; no retry | Short follow-ups: post/update a card after a form submit, `views.publish` on `app_home_opened`, `/nathan prs` response via `response_url` |
| **Cloudflare Queues** | consumer up to 15 min, retried | At-least-once. Default 3 retries, then DLQ. `delaySeconds` up to 24 h. Free plan: 10k ops/day, 24 h retention. Paid: 1M ops/month included, then $0.40/M ([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [batching & retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)) | Anything that must not be silently dropped (spec §5 "Nothing is silently dropped"), plus debounce/coalesce windows. Durable Object alarms are the other option; storage choice belongs to architecture |

## How each framework expresses it

- **slack-edge / slack-cloudflare-workers:** `app.globalShortcut(id, ack, lazy)`, `app.viewSubmission(id, ack, lazy)`, `app.command(name, ack, lazy)`, `app.action(id, ack, lazy)`, and `app.event(type, lazy)`. Events are auto-acked. The framework calls `ctx.waitUntil(lazy(req))` for you. The ordering flag `startLazyListenerAfterAck` defaults to `false`, so lazy starts *concurrently* with ack. `app.run(request, ctx)` is the Worker entry. Verified in source (`slack-edge/src/app.ts` L1000–1100) and in a local workerd test (see [framework-comparison.md](./framework-comparison.md#25-empirical-test-slack-cloudflare-workers-1310-in-local-workerd)).
- **Bolt JS:** no lazy listeners. You write a receiver that resolves the HTTP `Response` when `ack()` is called and hands `app.processEvent()` to `ctx.waitUntil`. The listener body after `await ack()` then becomes the "lazy" part. I verified this works in workerd, with fetch shims; see the comparison doc.

## Patterns for Nathan's flows (inference, grounded in the limits above)

1. **"Request PR" shortcut.** In the ack handler, call `views.open` with the trigger_id; that takes about 1 Slack round trip. Don't call GitHub before opening the modal.
2. **Dynamic "Mark ready for review" checkbox.** The spec wants the checkbox shown only for drafts. Put `dispatch_action: true` on the PR-URL input block, so Slack sends a `block_actions` payload when the user presses Enter (see [Input block](https://docs.slack.dev/reference/block-kit/blocks/input-block)). Ack immediately, then in lazy fetch the PR from GitHub and `views.update` the modal to add the checkbox. Pass the view `hash` to avoid clobbering concurrent edits. Without this, the alternative is to validate on submit and return a `response_action: "update"` that adds the checkbox.
3. **Modal submit validation.** Several spec rules need GitHub: PR exists and is open, repo tracked, draft state. Mapping lookups (reviewer has a GitHub mapping) need storage. All must finish inside the 3-second ack to show inline errors. **Inference:** one GitHub GraphQL/REST call plus one KV/D1 read normally fits in a few hundred ms, but there's no retry budget. Set a hard internal timeout of about 2–2.5 s. On timeout, ack with a generic inline error or `response_action: "update"` showing "checking…", rather than letting Slack show its own error.
4. **After a valid submit.** Ack with an empty body to close the modal. Then request reviewers on GitHub, post or update the card and post the threaded reply. Do this in lazy, or for durability enqueue to a Queue. If it fails, DM the submitter with partial-failure detail (spec §5); `chat.postMessage` to the user is the channel since the modal is gone. Global shortcuts carry no `response_url` ([Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction): "the payload from a global shortcut will not contain one"). A modal *can* generate one if it includes a `conversations_select` with `response_url_enabled` ([Modals](https://docs.slack.dev/surfaces/modals)).
5. **GitHub webhooks → card updates.** These go through Nathan's own GitHub endpoint, not Slack, so Slack's 3-second rule doesn't apply; GitHub has its own timeout (see the GitHub subtopic). The 1-minute reviewer debounce and 60-second handoff coalescing need a delayed trigger: a Queue with `delaySeconds: 60`, or a Durable Object alarm.
6. **Hourly sweep and daily report.** Run as Cron Triggers, not Slack requests, under the cron CPU limits above. Respect Slack rate limits ([slack-platform-features.md](./slack-platform-features.md#rate-limits)).
7. **Slack Events retries.** Because Nathan acks fast, retries should be rare. They still happen on cold-start or network blips, so dedupe on `event_id`, or ignore deliveries where `x-slack-retry-num` is present and the event was already handled. slack-edge exposes `retryNum` and `retryReason` on the request (src/app.ts L830–842).

## Sources

- [Slack: Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction): 3 s ack, trigger_id expiry, response_url 5×/30 min
- [Slack: Events API](https://docs.slack.dev/apis/events-api/): 3 s, retries, failure limits
- [Slack: Modals](https://docs.slack.dev/surfaces/modals): response_action, errors
- [Slack: Input block](https://docs.slack.dev/reference/block-kit/blocks/input-block): `dispatch_action`
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Context (waitUntil)](https://developers.cloudflare.com/workers/runtime-apis/context/), fetched 2026-10-01
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [batching & retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- `slack-edge` source v1.3.17 (`src/app.ts`)
