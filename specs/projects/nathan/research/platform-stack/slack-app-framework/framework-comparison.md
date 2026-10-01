# Slack framework on Cloudflare Workers (TypeScript): Bolt for JS vs slack-edge

Research date: 2026-10-01. Versions checked: `@slack/bolt` 5.1.0, `@slack/web-api` 8.2.0, `slack-edge` 1.3.17, `slack-cloudflare-workers` 1.3.10, `slack-web-api-client` 1.1.14, `wrangler` 4.145.0.

## TL;DR

| | **slack-cloudflare-workers** (on `slack-edge`) | **Bolt for JS** (`@slack/bolt`) |
|---|---|---|
| Who maintains it | Community. Written by Kazuhiro Sera (formerly Slack, author of most of Bolt), now at OpenAI. Since early 2026, releases are cut mainly by a second maintainer (Stephen Cook) | Slack (official) |
| Workers support | **Designed for Workers.** Web-standard `Request`→`Response`, Web Crypto, `fetch`. No `nodejs_compat` needed | **Not supported officially.** No fetch/Workers receiver ships. **Ran in local workerd** in my test, but only with `nodejs_compat`, a hand-written receiver and two fetch shims (below) |
| Ack-then-process | Built in: `ack` handler + `lazy` handler. Lazy runs via `ctx.waitUntil` | DIY. A custom receiver resolves the HTTP response when `ack()` is called and passes `app.processEvent()` to `ctx.waitUntil` |
| Bundle (my test worker, `wrangler deploy --dry-run`) | **199 KiB / 30.5 KiB gzip** | **2,862 KiB / 629 KiB gzip** (pulls in express, socket-mode, oauth…) |
| Typing | Strong. Typed payloads per handler, typed ack responses (the compiler rejected a wrong `view_submission` ack shape in my test), typed Web API client and Block Kit | Strong. `@slack/types` and `@slack/web-api` are the reference typings |
| Custom steps (`function_executed`) | `app.function(callbackId, lazy)` | `app.function()` / `CustomFunction` |
| Maturity signals | slack-edge: 152★, 2 open issues, 7 open PRs. slack-cloudflare-workers: 131★, 1 open issue. Releases every 1–3 months in 2025–26 | 2.9k★, 63 open issues, 20 open PRs. 5.0 (Jul 2026) and 5.1 (Sep 2026) |

**Recommendation (my inference):** use **`slack-cloudflare-workers`** as the Slack layer. It is the only option built for Workers, and its ack/lazy model matches the 3-second rule exactly. Contain the bus-factor risk with a thin adapter: Nathan's features talk to a small `SlackClient` interface, not to the framework directly. Bolt can run on workerd, but it is unsupported, 14× larger, and needs two monkey-patches that a future `@slack/web-api` release could break.

---

## 1. Bolt for JS on Workers

### 1.1 Official status

- Bolt ships `HTTPReceiver`, `ExpressReceiver`, `AwsLambdaReceiver` and `SocketModeReceiver`, and **no fetch-API/edge receiver**. Source: `src/receivers/` in [slackapi/bolt-js](https://github.com/slackapi/bolt-js) at 5.1.0. The repo source and docs never mention Cloudflare/workerd. I grepped the clone and the only "deno" hits are Deno Slack SDK cross-links.
- `HTTPReceiver` imports `node:net`/`node:url`/`node:http`. `ExpressReceiver` imports `express`, `raw-body` and `node:crypto`. `SocketModeReceiver` imports `@slack/socket-mode`. `App.ts` imports `HTTPReceiver` and `SocketModeReceiver` eagerly (bolt-js `src/App.ts` L63–64), so all of it lands in the bundle even when unused.
- Community issues asking for Workers support: [bolt-js#1803](https://github.com/slackapi/bolt-js/issues/1803) ("as a side effect of prefixing, you may be able to run bolt on Cloudflare Workers") and [node-slack-sdk#1335](https://github.com/slackapi/node-slack-sdk/issues/1335) (web-api unusable on Workers "since it uses axios").
- **What changed in 2026:** `@slack/web-api` 8.0.0 (2026-07-14) "Replaced `axios` with the standard Fetch API for all HTTP transport… The default `fetch` implementation is `globalThis.fetch`". Bolt 5.0.0 (2026-07-15) did the same for `response_url` calls ([web-api CHANGELOG](https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/CHANGELOG.md), [bolt-js CHANGELOG](https://github.com/slackapi/bolt-js/blob/main/CHANGELOG.md)). That removes the old axios blocker and is why Bolt now *nearly* runs on Workers.
- Bolt's own serverless guidance is Lambda-only. With non-Lambda receivers it says "`processBeforeResponse: true` is required… This option will defer sending back the acknowledgement until after your handler has run" (bolt-js `docs/english/deployments/aws-lambda.md`). That is the *opposite* of ack-then-process: it holds the ack until the work is done. **Bolt JS has no lazy listeners.** They are a Bolt *Python* feature, and grepping bolt-js `src/` for "lazy" finds nothing.

### 1.2 Empirical test: Bolt 5.1 in local workerd (`wrangler dev`, compat date 2026-09-01)

I wrote a Worker with a hand-rolled `Receiver`:
- It verifies the signature with Bolt's exported `verifySlackRequest`, which uses `node:crypto` and works under `nodejs_compat`.
- It builds a `ReceiverEvent` whose `ack()` resolves the `Response` promise.
- It hands `app.processEvent(event)` to `ctx.waitUntil`.

Results:

| Check | Result |
|---|---|
| Bundles with `nodejs_compat` | ✅ 2,862 KiB raw / 629 KiB gzip. Workers' limit is 64 MiB uncompressed with "no compressed size limit" and a **1 s startup** budget ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). I could not measure startup CPU: `wrangler check startup` needs Cloudflare network access the sandbox blocked |
| Bad signature → 401 | ✅ |
| Global shortcut: ack returned, work continues | ✅ HTTP 200 in ~28 ms. The listener kept running 4 s after the response (`ctx.waitUntil`) |
| `view_submission` ack with `response_action: errors` | ✅ returned as the HTTP body |
| `client.chat.postMessage` / `chat.update` via Bolt's `WebClient` | ❌ **`Illegal invocation: function called with incorrect this reference`.** `WebClient` stores `this.fetchFn = fetch ?? globalThis.fetch` and calls `this.fetchFn(url, …)` (`packages/web-api/src/WebClient.ts` L245/L612), which workerd rejects |
| …with `clientOptions.fetch: (u, i) => fetch(u, i)` | ❌ **`Invalid redirect value, must be one of "follow" or "manual"`.** `WebClient` passes `redirect: 'error'` (WebClient.ts L615), which workerd does not implement |
| …with `fetch: (u, i) => fetch(u, { ...i, redirect: 'manual' })` | ✅ both calls reached my mock Slack API with correct form bodies and Bearer token |

So Bolt *can* be made to work, but only with an **undocumented, unsupported** setup: a custom receiver plus a fetch wrapper that changes `redirect`. A Bolt release could change any of these internals. Note also `new App({ token, authorize })` throws: pass one or the other.

Test code: scratchpad only, not committed. The essential receiver pattern:

```ts
const app = new App({ receiver, authorize, clientOptions: { fetch: (u, i) => fetch(u, { ...i, redirect: "manual" }) } });
let resolveAck!: (r: Response) => void;
const acked = new Promise<Response>((r) => (resolveAck = r));
ctx.waitUntil(app.processEvent({ body, ack: async (resp) => resolveAck(new Response(resp ? JSON.stringify(resp) : "", { headers: { "content-type": "application/json" } })) }));
return acked; // NB: a real version must also time out/resolve if no listener calls ack()
```

### 1.3 Other Bolt adapters seen

- `@vercel/slack-bolt` 1.7.1 (vercel-labs, 2026-09-25) adapts Bolt to Vercel Functions using `@vercel/functions` `waitUntil` ([npm](https://www.npmjs.com/package/@vercel/slack-bolt)). It needs Node ≥22 and is Vercel-specific, not Workers. It shows the "Bolt + waitUntil" pattern has precedent, but nobody ships it for Workers.

## 2. slack-edge / slack-cloudflare-workers

### 2.1 What they are

- **`slack-edge`** ([repo](https://github.com/slack-edge/slack-edge), npm 1.3.17, 2026-05-14) is a runtime-neutral framework for "Cloudflare Workers, Vercel Edge Functions, Supabase Edge Functions… Deno, Bun, and Node.js". Its stated design points: "TypeScript focused", "Lazy listener enabled… bolt-python's lazy listener feature is provided out of the box", and "Zero additional dependencies… beyond… slack-web-api-client (our fetch-function-based Slack API client)" (README).
- **`slack-cloudflare-workers`** ([repo](https://github.com/slack-edge/slack-cloudflare-workers), npm 1.3.10, 2026-05-14; repo deps bumped 2026-09-23) is a 4-line `index.ts` that re-exports `slack-edge` and adds `KVInstallationStore` / `KVStateStore`, used only for multi-workspace OAuth. Nathan is single-workspace, so it would use `SlackApp` with `SLACK_BOT_TOKEN` and need neither.
- **`slack-web-api-client`** (npm 1.1.14, 2026-06-29) is the fetch-based typed Web API client used by both. It retries 429s by default (`RatelimitRetryHandler`). `ConnectionErrorRetryHandler` and `ServerErrorRetryHandler` are opt-in, and it accepts a `baseUrl` option.

### 2.2 Maintenance and maturity

- Commit history (full clone): Kazuhiro Sera 211 commits, Stephen Cook (tightknit.ai) 36, then a handful of others. First commit 2023-05-02. In 2026 most commits and releases are by Stephen Cook. Recent work: dependabot, knip, publish safeguards, and a fix so all matching event handlers run (#67).
- Sera wrote most of Bolt while at Slack and now works in developer experience at OpenAI ([GitHub profile](https://github.com/seratch), [LinkedIn](https://jp.linkedin.com/in/seratch)). **Inference:** effectively one or two part-time maintainers, outside Slack. The codebase is small enough to vendor or fork if it were abandoned: `src/app.ts` is 1,254 lines, and all of `src/` is about 7.8k lines, mostly types.
- Releases: slack-edge 1.3.12 (2025-08) → 1.3.13 (2026-01) → .14/.15 (2026-01/02) → .16 (2026-03) → .17 (2026-05). It is a living project, not a fast-moving one. New Slack platform features (e.g. the 2026 `agents.*` methods in `@slack/web-api` 8.x) reach it later than Bolt, or not at all.
- I could not get npm download counts: api.npmjs.org was blocked by the sandbox egress proxy.

### 2.3 How it handles a request (source: `slack-edge/src/app.ts`)

1. Reads the body once as text.
2. Short-circuits `ssl_check=1`.
3. Verifies the signature (`verifySlackRequest`, see below).
4. Parses form or JSON, then runs pre-authorize middleware. The built-in middleware answers `url_verification` challenges and ignores the bot's own events.
5. **`authorize()`**, then builds `context` with `client`, `say` and `respond`.
6. Dispatches by payload type. For each matched handler:
   ```ts
   if (!this.startLazyListenerAfterAck) ctx.waitUntil(handler.lazy(slackRequest)); // default: lazy starts in parallel
   const slackResponse = await handler.ack(slackRequest);
   if (this.startLazyListenerAfterAck) ctx.waitUntil(handler.lazy(slackRequest));
   return toCompleteResponse(slackResponse);
   ```
   - Events API handlers only take a lazy function, and the framework acks with an empty 200 for you.
   - `block_suggestion` (external select options) has no lazy handler, because the HTTP response *is* the answer.

Signature verification (`src/request/request-verification.ts`):
- Rejects a missing `x-slack-request-timestamp` or one older than 5 minutes.
- Checks `v0:{ts}:{body}` with `crypto.subtle.verify("HMAC", …SHA-256…)`. Web Crypto's `verify` is constant-time.
- Minor gap against Slack's spec: Slack says reject if `absolute_value(time.time() - timestamp) > 60 * 5`, but slack-edge only rejects *old* timestamps, not future-dated ones. Low risk, since the HMAC still has to match.

### 2.4 Gotchas found in the source / test

1. **Default `authorize` calls `auth.test` on every request.** `singleTeamAuthorize` does `new SlackAPIClient(botToken).auth.test()` per request, before the ack. That adds a Slack round trip (and a Tier-limited API call) to every 3-second budget. **Mitigation:** pass a custom `authorize` that returns cached bot identity, from env vars or KV populated once. I did this in my test.
2. **Lazy runs even when the ack rejects.** By default (`startLazyListenerAfterAck: false`) a `viewSubmission` lazy handler starts *in parallel with* the ack, so it runs even when the ack returns `response_action: "errors"`. My test log showed `[A] view lazy` firing for a submission that the ack rejected. Two fixes: do submission work only after re-checking validity inside lazy, or set `startLazyListenerAfterAck: true`. Even then lazy runs regardless of what ack returned, so the check is still needed.
3. **`trigger_id` expires in 3 s.** Opening a modal from a lazy handler works, as in the library's own example, but it races the 3-second trigger expiry. For Nathan's shortcut, open the modal **inside the ack handler**, or make it the first `await` in lazy with nothing slow before it.
4. **Client is created internally per request** (`new SlackAPIClient(primaryToken, { logLevel })`) with no `baseUrl` hook. To test handlers you mock global `fetch`, or wrap the client behind Nathan's own interface.

### 2.5 Empirical test: slack-cloudflare-workers 1.3.10 in local workerd

No `nodejs_compat` flag. Custom `authorize`. Signed requests from a Node script.

| Check | Result |
|---|---|
| Global shortcut | HTTP 200 in ~20 ms server-side. Lazy completed 4,008 ms later via `waitUntil` |
| Bad signature | HTTP 401 `Invalid signature` |
| `view_submission` with invalid URL | HTTP 200 `{"response_action":"errors","errors":{"pr":"That's not a GitHub PR URL"}}` |
| Slash command | HTTP 200 body `working on it...` (ephemeral by default), lazy ran |
| `tsc --strict` | Rejected an ack function whose return type wasn't a valid `ViewAckResponse` union. Good typing |

## 3. Typing quality and testability

- **Types:** both are fully typed. slack-edge ships its own payload types (`ViewSubmission`, `GlobalShortcut`, `SlashCommand`, `BlockAction<…>`, `ViewStateValue`…) and Block Kit types in `slack-web-api-client/block-kit`. Bolt uses the official `@slack/types`, the reference. Expect slack-edge to trail on new Block Kit elements. **Inference:** Nathan's set (section, context, actions, input, url_text_input, multi_users_select, checkboxes, static_select) is long-established.
- **Testability:** Cloudflare's Vitest integration (now `@cloudflare/vitest-plugin`; `@cloudflare/vitest-pool-workers` has a migration guide) runs tests inside workerd. It provides `createExecutionContext()` / `waitOnExecutionContext(ctx)` to await `waitUntil` work ([Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)). Outbound-fetch mocking isn't covered on that page; I did not research it further. **Recommendation (inference):** handlers should be thin. Parse the payload, call pure feature functions, call a `SlackGateway` interface. That makes the framework irrelevant to most tests, and matches the functional spec's "core logic is pure and unit-testable" requirement.

## Sources

- [slackapi/bolt-js](https://github.com/slackapi/bolt-js): source and docs at v5.1.0 (cloned 2026-10-01); CHANGELOG 5.0.0/5.1.0
- [node-slack-sdk web-api CHANGELOG](https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/CHANGELOG.md): 8.0.0 fetch migration (2026-07-14); `WebClient.ts` source
- [bolt-js#1803](https://github.com/slackapi/bolt-js/issues/1803), [node-slack-sdk#1335](https://github.com/slackapi/node-slack-sdk/issues/1335): Workers support requests
- [slack-edge/slack-edge](https://github.com/slack-edge/slack-edge): README and `src/app.ts`, `src/request/request-verification.ts`, `src/authorization/single-team-authorize.ts` at 1.3.17
- [slack-edge/slack-cloudflare-workers](https://github.com/slack-edge/slack-cloudflare-workers): README, `docs/simple_app.md`, `src/` at 1.3.10
- npm registry metadata (registry.npmjs.org) for version and publish dates
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/): size, startup, CPU, `waitUntil` 30 s
- [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [@vercel/slack-bolt](https://www.npmjs.com/package/@vercel/slack-bolt): Bolt + waitUntil adapter for Vercel
- [seratch on GitHub](https://github.com/seratch), [LinkedIn](https://jp.linkedin.com/in/seratch): maintainer background
