# Slack platform features Nathan's UX needs

Framework-independent: everything here is the Slack platform and works the same from slack-edge or Bolt. Checked 2026-10-01 against docs.slack.dev.

## 1. "Request PR" entry point: shortcut + modal vs Workflow Builder custom step

### Option A — Global shortcut → modal (recommended primary)
- Global shortcuts "are available to users via the shortcuts button in the message composer… and when using search in Slack". They need the **`commands`** scope ("To make shortcuts available in Slack, your app must have the `commands` permission scope") ([Implementing shortcuts](https://docs.slack.dev/interactivity/implementing-shortcuts)).
- A global shortcut payload has a `trigger_id` but **no channel and no `response_url`** ([Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction); also [StackOverflow](https://stackoverflow.com/questions/76328066/how-to-send-message-to-slack-channel-after-triggering-global-shortcut)). That's fine, since Nathan always posts to the configured `#prs`.
- Modals give everything the spec wants:
  - **inline field errors.** `{"response_action":"errors","errors":{"<block_id>":"message"}}` "would highlight the error within the modal around the… block". The key is the input **block_id**, and you have 3 s ([Modals](https://docs.slack.dev/surfaces/modals)).
  - **`update` / `push` / `clear` response actions** ([Modals](https://docs.slack.dev/surfaces/modals)).
  - **Elements:** `url_text_input` for the PR link ([URL input](https://docs.slack.dev/reference/block-kit/block-elements/url-input-element)), `multi_users_select` for reviewers, `checkboxes` for modifiers and "mark ready", and multiline `plain_text_input` for the note.
  - **`dispatch_action`** on an input block sends a `block_actions` payload as the user enters data. Use it to look up the PR and add the draft checkbox ([Input block](https://docs.slack.dev/reference/block-kit/blocks/input-block)).
- Works on **all plans, including Free**. Custom steps and Workflow Builder do not (below).

### Getting a button into the `#prs` bookmark bar
- A global shortcut has **no URL**, so it can't be a channel bookmark by itself. What *can* be bookmarked is a **workflow link trigger**: "You can send this to a channel or add it as a bookmark, then click it to begin the workflow" ([Deno: link triggers](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-link-triggers)). In Workflow Builder this is "From a link in Slack" (bolt-js tutorial `custom-steps-workflow-builder-new.md`). Users today do exactly this: "copy the trigger link for the workflow and paste it to a bookmark" ([r/Slack](https://www.reddit.com/r/Slack/comments/1941l2f/need_help_with_creating_workflows)).
- So the bookmark has to point at a **workflow**. That gives two sub-options:
  - **B1 — WB form + our custom step.** Workflow (link trigger, bookmarked) → built-in "Collect info in a form" step → **our custom step** "Request PR review" that receives the inputs and does the work. ✅ It keeps today's workflow UX. ❌ It **loses inline validation**: WB forms have no per-field error hook back to our app. A bad PR link can only `fail()` the step, which surfaces as a workflow error, not an inline field error. ❌ It also can't show the draft checkbox conditionally.
  - **B2 — custom step that opens *our* modal.** Workflow (link trigger) → our custom step, which takes an `interactivity` input and calls `views.open` with its `interactivity_pointer`. The Deno SDK documents this ("When opening a modal view via link trigger, add a property with the type `Schema.slack.types.interactivity`… access… `inputs.interactivity.interactivity_pointer`", [Deno: interactive modals](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-an-interactive-modal)). ⚠️ **Unverified for Bolt/HTTP apps configured in Workflow Builder.** I found no Bolt-JS doc or sample showing a WB-configured custom step receiving the link trigger's interactivity. An old bolt-js issue on exactly this ([#1984](https://github.com/slackapi/bolt-js/issues/1984), 2023) was closed as stale with "support doesn't currently exist in Bolt JS for next-gen". Needs a prototype.
- **Custom-step prerequisites** (bolt-js tutorial `docs/english/tutorials/custom-steps.md`, [Workflow steps](https://docs.slack.dev/workflows/workflow-steps)):
  - "This feature requires a paid plan." The [plan matrix](https://slack.com/help/articles/115003205446-Slack-plans-and-features) shows Workflow Builder and custom steps on Pro and above.
  - The app must be **org-ready**: `settings.org_deploy_enabled: true`.
  - The app must subscribe to the `function_executed` event and define steps in the manifest `functions` section.
  - "the app must be installed at the organization level. While it is possible to install the app at a workspace level, doing so means that the custom steps will not appear in Workflow Builder." **Unclear for a standalone (non-Enterprise) workspace.** The docs say distribution "works differently… within a standalone (non-Enterprise Grid) workspace versus within an Enterprise Grid organization" but the fetched excerpt didn't spell it out.
  - Apps with custom steps "cannot be distributed publicly or submitted to the Slack Marketplace". That's irrelevant for Nathan.
  - Cost: usage-based billing for workflows with custom steps **ended 2024-09-25** ("workflows with two (or more) connector steps or custom steps no longer cost extra", [Slack updates](https://slack.com/help/articles/115004846068-Slack-updates-and-changes)).
  - Custom steps must call `complete({outputs})` or `fail({error})` (functions.completeSuccess / completeError), possibly later from an interactivity handler ([Bolt custom steps](https://docs.slack.dev/tools/bolt-js/concepts/custom-steps)).
- **Simpler bookmarkable alternatives (inference):**
  - (a) The App Home tab has a "Request PR" button: `block_actions` gives a trigger_id, then `views.open`.
  - (b) Nathan posts a pinned or bookmarked message in `#prs` containing a "Request PR" button. A bookmark to a message permalink jumps to it, then one click opens the modal.
  - Both use only interactivity and need no WB, custom steps or org-ready config.

**Recommendation (inference):** ship the **global shortcut + modal** as the primary path. It's the only one that meets the spec's inline-validation and conditional-draft-checkbox requirements on any plan.

For the `#prs` bookmark, prefer one of the zero-config button options above. Treat **B2** (a link-triggered workflow whose custom step opens Nathan's modal) as an optional nice-to-have, after a 1-hour prototype confirms that WB passes interactivity to a Bolt/HTTP custom step in this workspace. Avoid **B1**: it reproduces the current WB form and its lack of validation, which is part of why Nathan is replacing it. slack-edge supports `app.function(callbackId, lazy)` for `function_executed`, so B2 is not blocked by the framework choice.

## 2. Live cards: `chat.postMessage` + `chat.update`
- `chat.update` "updates a message in a channel"; scope `chat:write`; **Tier 3 (50+/min)**. "Ephemeral messages… cannot be updated with this method" ([chat.update](https://docs.slack.dev/reference/methods/chat.update)). Nathan must persist `channel` + `ts` per PR. `chat.postMessage` returns `ts`.
- `chat.postMessage`: scope `chat:write`. To post in public channels the bot isn't a member of, it needs `chat:write.public` ("New Slack apps do not begin life with the ability to post in all public channels"). Simpler: invite the bot to `#prs` ([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)).
- Final state reaction (🟣/⚫): `reactions.add`, scope **`reactions:write`**, Tier 3 ([reactions.add](https://docs.slack.dev/reference/methods/reactions.add); tier from search-result snippet of the same page).

## 3. Threaded replies with @mentions
- Threaded reply = `chat.postMessage` with `thread_ts` = card `ts` (same scope and limits).
- Mention syntax `<@U012AB3CD>`: "If the mention is included in an app-published message, the mentioned user will also be notified" ([Formatting message text](https://docs.slack.dev/messaging/formatting-message-text)).
- **Edits don't notify.** Adding a mention via `chat.update` does not ping anyone ("If you edit a message to add an @mention, do not rely on it to reach that person; send a new message", [Pylon support article](https://support.usepylon.com/articles/5381080574-do-edited-broadcasts-re-notify-slack-channels); third-party, not Slack docs, but consistent with Slack's UX). This supports the spec's design: owners in the card are informational, and handoffs and reminders are *new threaded replies*.

## 4. DMs (draft nudges, error reports)
- `conversations.open` (bot scope `im:write` for 1:1) returns the DM channel. Tier 3 ([conversations.open](https://docs.slack.dev/reference/methods/conversations.open)). Then `chat.postMessage`.
- Many apps post with `channel: <user_id>` directly to reach the App Home Messages tab. I did not verify that in current docs, so use `conversations.open` to be safe.

## 5. App Home tab
- The App Home has Home, Messages and About tabs. It's "only available in granular permission Slack apps, not slack apps created with the Deno Slack SDK or workflows". You publish with `views.publish` (`type: "home"`, `user_id`), typically on the `app_home_opened` event ([App Home](https://docs.slack.dev/surfaces/app-home)).
- `views.publish`: "No scopes required", **Tier 4 (100+/min)**. It returns `not_enabled` if the Home tab isn't enabled in app settings ([views.publish](https://docs.slack.dev/reference/methods/views.publish)).
- `app_home_opened` carries `tab` (`home`/`messages`). If a view was published before, it also carries the current `view` ([app_home_opened](https://docs.slack.dev/reference/events/app_home_opened)). This lets Nathan meet "refreshes when opened": ack the event, compute the queue, `views.publish` in lazy.
- **Inference:** a "loading…" view can be published first, then the full one, if computation risks being slow.

## 6. Slash command `/nathan prs`
- Needs the `commands` scope and a Request URL. Same 3 s ack. Default `response_type` is `ephemeral`. Replying with an empty 200 shows nothing ([Implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands)).
- Pattern: ack with short ephemeral text ("Fetching your queue…"), then POST the full ephemeral content to `response_url` (≤5 times within 30 min) from lazy. Alternatively, `chat.postEphemeral` (`chat:write`, Tier 4, [chat.postEphemeral](https://docs.slack.dev/reference/methods/chat.postEphemeral)), but that requires the bot in the channel.

## 7. User time zone (`users.info`)
- Scope **`users:read`**. The response includes `user.tz` (e.g. `"America/Los_Angeles"`), `tz_label` and `tz_offset` (seconds, e.g. `-25200`) ([users.info](https://docs.slack.dev/reference/methods/users.info)).
- Rate limit **Tier 4 (100+/min)**. I took this from search-result snippets of the same page; the fetched excerpt omitted the Facts box.
- `users.list` is Tier 2 (20+/min) with `users:read` ([users.list](https://docs.slack.dev/reference/methods/users.list)).
- Use the IANA `tz` rather than `tz_offset` for weekend math, because the offset is DST-dependent. Cache per user per sweep.

## 8. Request signature verification
Slack's algorithm ([Verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack)):
1. Read the **raw** body.
2. Reject if `|now - X-Slack-Request-Timestamp| > 300 s` (replay protection).
3. Build `v0:{timestamp}:{raw_body}`.
4. Compute HMAC-SHA256 with the signing secret, take the hex digest, and compare to `X-Slack-Signature` (`v0=…`) in constant time.

- On Workers this is `crypto.subtle.importKey` + `crypto.subtle.verify("HMAC", …)`, which slack-edge does already (see [framework-comparison.md §2.3](./framework-comparison.md#23-how-it-handles-a-request-source-slack-edgesrcappts)). Bolt's `verifySlackRequest` uses `node:crypto` and needs `nodejs_compat`.
- **Edge cases:**
  - Slack's URL-verification `ssl_check=1` pings carry no signature. slack-edge short-circuits them, and bolt-js 4.7.2 tightened the same check to "Require exact `ssl_check=1` value".
  - An **empty signing secret** must be rejected at boot. bolt-js 4.7.3 added that after noticing "accidental HMAC signature forgery" risk ([bolt-js CHANGELOG](https://github.com/slackapi/bolt-js/blob/main/CHANGELOG.md)). **Inference:** Nathan's config loader should assert it's non-empty, whichever framework is used.
  - Bolt 5.1 added a 4 MB body cap before verification, as a DoS fix. Workers caps request bodies at the platform level. I did not research the exact figure since hosting is out of scope.

## Rate limits

From [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits): "Your app's requests to the Web API are evaluated per method, per workspace. Rate limit windows are per minute." The tiers are Tier 2 20+/min, Tier 3 50+/min ("Sporadic bursts are welcome") and Tier 4 100+/min. Exceeding a limit returns HTTP 429 with `Retry-After`.

| Method | Tier | Scope | Nathan use |
|---|---|---|---|
| `chat.postMessage` | **Special:** "generally allow an app to post 1 message per second to a specific channel… limits governing… the entire workspace… several hundred messages per minute. Generous burst behavior" | `chat:write` | cards, thread replies, report, DMs |
| `chat.update` | Tier 3 (50+/min) | `chat:write` | live cards |
| `chat.postEphemeral` | Tier 4 | `chat:write` | optional |
| `views.open` / `views.update` / `views.publish` | Tier 4 (open, publish verified) | none | modal, App Home |
| `users.info` | Tier 4 (search snippet) | `users:read` | time zones |
| `reactions.add` | Tier 3 (search snippet) | `reactions:write` | merged/closed reaction |
| `conversations.open` | Tier 3 | `im:write` | draft DMs |
| `bookmarks.add` | Tier 2 | `bookmarks:write` | only if Nathan creates the bookmark itself (optional) |

**Implications (inference):**
- **Per channel:** all thread replies, cards and the daily report go to `#prs`, so they share the ~1 msg/s per-channel budget. The hourly sweep should pace posts, e.g. ≥1 s apart, and honour 429 `Retry-After`. `slack-web-api-client` retries 429s by default; `@slack/web-api` also queues and retries.
- **`chat.update` at 50+/min per workspace** is ample if the sweep only updates cards whose rendered content changed. Store a hash of the last-rendered blocks per card. Re-rendering every card hourly would only hit the limit with roughly 50 or more open PRs. The age field changes every sweep, so either drop age granularity in the card (days, not hours) or accept the cost.
- Nathan never needs to read channel history (it stores `ts`), so the history-reading methods and their limits are out of scope. I recall a 2025 tightening of `conversations.history`/`replies` limits for non-Marketplace apps, but that is **unverified from memory**; I did not research it.

## Required bot scopes (minimum for the spec)

| Scope | Why |
|---|---|
| `commands` | global shortcut + `/nathan` |
| `chat:write` | post/update cards, thread replies, report, ephemeral |
| `users:read` | `users.info` time zone; mapping UI |
| `reactions:write` | merged/closed reaction |
| `im:write` | open DMs for draft nudges and error reports |
| *(optional)* `chat:write.public` | only if the bot isn't invited to `#prs` / test channel |
| *(optional)* `bookmarks:write` | only if Nathan manages the `#prs` bookmark itself |

Plus app settings: Interactivity Request URL; Event Subscriptions Request URL with bot event `app_home_opened` (and `function_executed` only if custom steps are used); App Home → Home tab enabled; shortcut and slash-command definitions. **Inference:** none of the events Nathan needs require message-reading scopes (`channels:history` etc.); verify when writing the manifest.

## Sources

- [Implementing shortcuts](https://docs.slack.dev/interactivity/implementing-shortcuts): `commands` scope, global vs message
- [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction): 3 s, trigger_id, response_url
- [Modals](https://docs.slack.dev/surfaces/modals): response_action, errors
- [Input block](https://docs.slack.dev/reference/block-kit/blocks/input-block), [URL input element](https://docs.slack.dev/reference/block-kit/block-elements/url-input-element)
- [Workflow steps](https://docs.slack.dev/workflows/workflow-steps), [Bolt JS custom steps](https://docs.slack.dev/tools/bolt-js/concepts/custom-steps), bolt-js repo `docs/english/tutorials/custom-steps*.md` (v5.1.0)
- [Deno: link triggers](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-link-triggers), [Deno: interactive modals](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-an-interactive-modal)
- [bolt-js#1984](https://github.com/slackapi/bolt-js/issues/1984): open modal from Bolt custom function (2023, stale)
- [Slack updates and changes](https://slack.com/help/articles/115004846068-Slack-updates-and-changes): workflow billing ended 2024-09-25
- [Slack plans and features](https://slack.com/help/articles/115003205446-Slack-plans-and-features): WB/custom steps on paid plans
- [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage), [chat.update](https://docs.slack.dev/reference/methods/chat.update), [chat.postEphemeral](https://docs.slack.dev/reference/methods/chat.postEphemeral), [reactions.add](https://docs.slack.dev/reference/methods/reactions.add), [conversations.open](https://docs.slack.dev/reference/methods/conversations.open), [views.open](https://docs.slack.dev/reference/methods/views.open), [views.publish](https://docs.slack.dev/reference/methods/views.publish), [users.info](https://docs.slack.dev/reference/methods/users.info), [users.list](https://docs.slack.dev/reference/methods/users.list), [bookmarks.add](https://docs.slack.dev/reference/methods/bookmarks.add)
- [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits)
- [Formatting message text](https://docs.slack.dev/messaging/formatting-message-text): mentions
- [App Home](https://docs.slack.dev/surfaces/app-home), [app_home_opened](https://docs.slack.dev/reference/events/app_home_opened)
- [Implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands)
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack)
- [Pylon: do edited broadcasts re-notify](https://support.usepylon.com/articles/5381080574-do-edited-broadcasts-re-notify-slack-channels): third-party, edits don't notify
