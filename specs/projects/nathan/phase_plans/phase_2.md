---
status: complete
---

# Phase 2: Slack gateway

## Overview

Build `src/slack/`, the only place that touches `slack-edge`, and plug it into the platform core. After this phase:

- features get a full outbound `SlackClient` (post, update, react, DM, modals, App Home, ephemeral replies, time zone lookup) through `services.slack`
- features declare inbound Slack interactions through `registrar.slack` (`SlackRegistry`): global shortcuts, view submissions, block actions, `/nathan` subcommands and App Home sections
- `POST /slack/events` verifies, acks and runs lazy work through slack-edge, with a cached `authorize` and the ack/lazy rules from the research
- `/nathan help` is generated from the registered subcommands, and the App Home tab is composed from feature sections
- `services.directory` maps Slack ↔ GitHub users and resolves time zones (config override → D1 cache → `users.info` → default)
- dry run reroutes every post to the test channel with mentions defused
- both Slack app manifests exist, and `docs/setup.md` describes creating the apps

No feature registers anything yet (V1's feature arrives in phase 4/5), so `/nathan` only offers `help` and the App Home shows a placeholder.

## Steps

1. **Dependencies and lint rules**
   - Add `slack-edge` (^1.3.17). It re-exports `slack-web-api-client`, so that is not a direct dependency. `slack-cloudflare-workers` is not added: it only adds multi-workspace KV OAuth stores, which a single-workspace app doesn't use.
   - `biome.json`: also restrict `slack-web-api-client` to `src/slack/**`, like `slack-edge`.

2. **`src/slack/types.ts`**: the outbound surface and Block Kit types.
   ```ts
   export type MessageBlock = AnyMessageBlock; export type ModalBlock = AnyModalBlock; export type HomeBlock = AnyHomeTabBlock;
   export type { ModalView, HomeTabView, ViewStateValue };   // type-only re-exports from slack-edge
   export interface SlackMessage { channel: string; text: string; blocks?: MessageBlock[]; thread_ts?: string }
   export interface PostedMessage { channel: string; ts: string }
   export interface MessageUpdate { channel: string; ts: string; text: string; blocks?: MessageBlock[] }
   export interface DirectMessage { text: string; blocks?: MessageBlock[] }
   export interface EphemeralReply { text: string; blocks?: MessageBlock[] }
   export interface OpenedView { viewId: string; hash: string }
   export interface BotIdentity { botId: string; botUserId: string }
   export interface SlackClient {
     postMessage(m: SlackMessage): Promise<PostedMessage>;
     updateMessage(m: MessageUpdate): Promise<void>;
     addReaction(r: { channel: string; ts: string; name: string }): Promise<void>;   // already_reacted is not an error
     sendDirectMessage(userId: string, m: DirectMessage): Promise<PostedMessage>;    // conversations.open + chat.postMessage
     respond(responseUrl: string, reply: EphemeralReply): Promise<void>;             // ephemeral via response_url
     openView(triggerId: string, view: ModalView): Promise<OpenedView>;
     updateView(u: { viewId: string; hash?: string; view: ModalView }): Promise<void>;
     publishHome(userId: string, view: HomeTabView): Promise<void>;
     userTimeZone(userId: string): Promise<string | null>;                           // users.info → user.tz
     authTest(): Promise<BotIdentity>;
   }
   ```

3. **`src/slack/client.ts`**: `createSlackApiClient(botToken, options?: { baseUrl? })` implements `SlackClient` over `SlackAPIClient` (429 retries are built in). `respond` POSTs `{ response_type: "ephemeral", ...reply }` with `fetch` and throws on a non-2xx.

4. **`src/slack/dry_run.ts`**: `createDryRunSlackClient(inner, { testChannel, nameOf: (slackId) => string | undefined })`:
   - `postMessage` / `updateMessage` / `addReaction` go to `testChannel` (thread_ts and ts kept, since the parent was posted there too).
   - `sendDirectMessage` becomes a `testChannel` post.
   - Text gets a `[dry-run → <#C…>]` / `[dry-run → DM @name]` prefix. When there are blocks, a context block with the same prefix is prepended.
   - `defuseMentions(text, nameOf)`: `<@U…>` / `<@U…|label>` → `@name` (directory name, else label, else the ID), `<!here>` / `<!channel>` / `<!everyone>` → `@here` etc., `<!subteam^S…|@team>` → `@team`. Applied to the text and to every string inside blocks.
   - Reads (`userTimeZone`, `authTest`), views (`openView`, `updateView`, `publishHome`) and `respond` (ephemeral, shown only to the requester) pass through.

5. **`src/slack/blocks.ts`**: Block Kit helpers.
   - Text: `escapeText` (`&`, `<`, `>`), `link(url, label)`, `mention(slackId)`, `channelLink(id)`, `truncate(text, max)`, `mrkdwn(text)`, `plainText(text)`.
   - Blocks: `header`, `section(text, { accessory?, fields? })`, `context(...texts)`, `divider`, `actions(...elements)`, `input({ blockId, label, element, optional?, hint?, dispatchAction? })`.
   - Elements: `button({ text, actionId, value?, url?, style? })`, `urlInput`, `textInput({ actionId, multiline?, placeholder?, initialValue? })`, `multiUsersSelect`, `checkboxes({ actionId, options, initialValues? })`.
   - Views: `modal({ callbackId, title, submit?, close?, blocks, privateMetadata? })` (title truncated to Slack's 24 chars), `homeView(blocks)`.
   - Limits: `MAX_SECTION_TEXT = 3000`, `MAX_MESSAGE_BLOCKS = 50`, `MAX_VIEW_BLOCKS = 100`. `section` and `context` truncate to Slack's limits.

6. **`src/slack/registry.ts`**: inbound registrations.
   ```ts
   export interface SlackRegistry {
     shortcut(callbackId: string, handler: ShortcutHandler): void;         // global shortcuts
     viewSubmission(callbackId: string, handler: ViewSubmissionHandler): void;
     action(actionId: string, handler: ActionHandler): void;               // block_actions, exact action_id
     command(name: string, handler: CommandHandler): void;                 // `/nathan <name> …`
     homeSection(section: HomeSection): void;
   }
   interface ShortcutHandler { ack(req: ShortcutRequest): Promise<void>; lazy?(req: ShortcutRequest): Promise<void> }
   type ViewSubmissionAck = void | { errors: Record<string, string> } | { update: ModalView } | { push: ModalView } | { clear: true };
   interface ViewSubmissionHandler { ack(req): Promise<ViewSubmissionAck>; lazy?(req): Promise<void> }
   interface ActionHandler { ack?(req: ActionRequest): Promise<void>; lazy?(req: ActionRequest): Promise<void> }
   type CommandReply = string | EphemeralReply;
   interface CommandHandler { description: string; usage?: string; ack?(req): Promise<CommandReply | void>; lazy?(req): Promise<void> }
   interface HomeSection { order: number; render(req: { userId: string }): Promise<HomeBlock[]> }
   ```
   - Request types are Nathan's own, mapped from slack-edge payloads: `ShortcutRequest { userId, triggerId }`, `ViewSubmissionRequest { userId, triggerId, callbackId, viewId, viewHash, privateMetadata, values }`, `ActionRequest { userId, triggerId, actionId, blockId, value?, view?: { id, hash, callbackId, privateMetadata, values }, channelId?, messageTs? }`, `CommandRequest { userId, channelId, triggerId, command, args, respond(reply) }`.
   - `SlackHandlers` stores registrations with their feature id. `forFeature(featureId): SlackRegistry`. Duplicate callback IDs / action IDs / subcommands throw (across features too). Subcommand names must match `^[a-z][a-z0-9-]*$`; `help` is reserved.

7. **`src/slack/commands.ts`**: `parseCommandText(text) → { subcommand, args }` (first whitespace token lowercased, rest trimmed), and `helpText(command, entries)` listing `help` plus every subcommand (sorted) with usage and description. Empty text or `help` → help. Unknown → "I don't know `/nathan foo`." followed by the help.

8. **`src/slack/home.ts`**: `composeHome(sections, userId, isolate)` renders sections in `order` (ties keep registration order), with a divider between non-empty sections. A section that throws is reported and replaced by a "this section couldn't load" context block. No content → a short placeholder. More than `MAX_VIEW_BLOCKS` → truncated with a closing context note.

9. **`src/slack/gateway.ts`**: `createSlackGateway({ signingSecret, botToken, handlers, slack, reportError, log })` → `{ handle(request, ctx): Promise<Response> }`.
   - Builds one `SlackApp` with `startLazyListenerAfterAck: true` and a cached `authorize`: `slack.authTest()` memoized per isolate (a failed lookup isn't cached), returning `{ botToken, botId, botUserId, botScopes: [] }`. slack-edge verifies the signature (401) and answers `url_verification`/`ssl_check`.
   - Each registration is wired with an ack wrapper and a lazy wrapper sharing a per-request outcome (`WeakMap` keyed on slack-edge's request object):
     - ack throws → `reportError` (source `<featureId>.<kind>:<id>`, via `ctx.waitUntil`) and the lazy is skipped. Commands then reply with an ephemeral "Sorry, that failed…" message; other kinds return HTTP 500 so Slack shows its own error.
     - a view submission ack that returns `errors` → the lazy is skipped (slack-edge would otherwise run it).
     - lazy runs inside `runIsolated` with the same source.
   - `/nathan`: one `command(/.*/)` listener (the manifest defines the one command, `/nathan` or `/nathan-staging`). The ack parses the text; help/unknown answer inline; a known subcommand runs its ack (default: no visible reply) and lazy.
   - `app_home_opened` (tab `home` only): lazy composes the home and `slack.publishHome`s it.

10. **`src/slack/index.ts`**: the public surface features may import: the types above, the registry and request types, and the block helpers. Core-only constructors (`createSlackApiClient`, `createDryRunSlackClient`, `createSlackGateway`, `SlackHandlers`) are imported by `src/core/app.ts` from their modules.

11. **`src/core/directory.ts`**:
    ```ts
    export interface DirectoryUser { github: string; slack: string; tz?: string }
    export interface UserDirectory {
      bySlack(slackId: string): DirectoryUser | undefined;
      byGithub(login: string): DirectoryUser | undefined;   // case-insensitive, "[bot]" suffix ignored
      slackMention(login: string): string | null;            // "<@U…>" or null
      timezone(slackId: string): Promise<string>;
    }
    export const TZ_CACHE_TTL_MS = 24h;
    createUserDirectory({ users, defaultTimezone, db, clock, slack, log })
    ```
    `timezone`: config `tz` → fresh `slack_user_tz` row (< 24h) → `slack.userTimeZone` (valid zones are upserted) → stale row → `defaults.timezone`. A `users.info` failure is logged at warn, never thrown.

12. **`src/core/feature.ts`**: `Registrar.slack: SlackRegistry`; `Services.directory: UserDirectory`.

13. **`src/core/app.ts`**:
    - Secrets: `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` via `requireSecret` (missing → throws at startup).
    - Outbound: `overrides.slack ?? createSlackApiClient(botToken)`, then the directory over it, then `createDryRunSlackClient` when `platform.dryRun` (names from the directory: `@<github login>`). `services.slack` and `reportError` use the (possibly wrapped) client.
    - Registrars get `slack: handlers.forFeature(id)`.
    - After registration, build the gateway and route `POST /slack/events` to it.

14. **`src/slack/index.ts` cleanup**: remove `unwiredSlackClient` (replaced by the real client).

15. **Manifests**: `slack-manifest.production.yaml` and `slack-manifest.staging.yaml`. Bot scopes `commands`, `chat:write`, `users:read`, `reactions:write`, `im:write`; bot event `app_home_opened`; Home tab on, Messages tab read-only; interactivity, events and the slash command all at `https://nathan-<env>.<subdomain>.workers.dev/slack/events`; global shortcut `request_pr` ("Request PR review"); slash command `/nathan` vs `/nathan-staging`; staging's display name "Nathan (staging)".

16. **`docs/setup.md`**: fill the Slack app section (create from manifest, replace the URL placeholder, install, copy the bot token and signing secret into secrets, invite Nathan to the PR and test channels, `.dev.vars` for local).

17. **Test infrastructure**:
    - `vitest.config.ts`: test bindings `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`; `test/env.d.ts` types them.
    - `test/fakes/slack.ts`: `FakeSlack` implements the full `SlackClient`, recording `posts`, `updates`, `reactions`, `dms`, `responses`, `openedViews`, `updatedViews`, `homes`, with settable `timeZones` and failure injection.
    - `test/helpers/slack.ts`: `signedSlackRequest(body)` (form or JSON, HMAC-signed with the test secret) and payload builders `shortcutBody`, `viewSubmissionBody`, `blockActionBody`, `commandBody`, `appHomeOpenedBody`.

## Tests

- `test/slack/client.test.ts` (fetch spied): each method calls the right Web API method with the right arguments and maps the result; `addReaction` ignores `already_reacted` but throws other errors; `sendDirectMessage` opens the DM first; `respond` posts ephemeral JSON and throws on a non-2xx; `userTimeZone` returns null without a tz; an `ok: false` response throws.
- `test/slack/dry_run.test.ts`: posts/updates/reactions go to the test channel with the prefix; blocks get a prefix context block; mentions defused in text and nested block strings (mapped name, label fallback, ID fallback, `<!here>`, subteam); DMs become test-channel posts naming the recipient; thread_ts preserved; views, `respond` and reads pass through untouched.
- `test/slack/blocks.test.ts`: escaping, link/mention formats, `truncate`, section/context truncation, `modal` title truncation and optional fields, `input` options, `button` options.
- `test/slack/commands.test.ts`: parsing (empty, case, extra whitespace, args); help lists `help` and sorted subcommands with usage, using the invoked command name.
- `test/slack/home.test.ts`: ordering by `order` then registration; dividers only between non-empty sections; a throwing section is reported and replaced; placeholder when empty; truncation over 100 blocks.
- `test/slack/registry.test.ts`: duplicate shortcut/view/action/subcommand rejected (also across features); invalid and reserved subcommand names rejected.
- `test/slack/gateway.test.ts` (through `app.fetch` with signed requests and `FakeSlack`):
  - bad signature → 401; `url_verification` answered
  - authorize calls `authTest` once per app, and again after a failure
  - shortcut: ack runs before lazy; lazy runs after ack via `waitUntil`
  - view submission: `errors` ack returned inline and lazy skipped; accepted ack closes the modal (empty body) and lazy runs; `update` ack returned
  - action routed by `action_id` with view state mapped
  - ack throws → reported with the feature source, 500, lazy skipped; lazy throws → reported, other work unaffected
  - `/nathan` with no text and `help` → help text naming the invoked command; unknown subcommand → error + help; subcommand ack reply returned, args parsed, lazy `respond` reaches `FakeSlack`; a throwing subcommand ack → ephemeral apology and a report
  - `app_home_opened` publishes the composed home for the user; `messages` tab ignored
- `test/core/directory.test.ts`: lookups by Slack and GitHub (case, `[bot]`), `slackMention`; `timezone` override wins without calls; fresh cache used without calls; missing/stale cache fetches and stores; invalid or missing Slack tz → default (not cached); fetch failure → stale cache, else default, with a warn.
- `test/core/app.test.ts` additions: missing Slack secrets fail startup; dry-run config wraps `services.slack` (a feature post lands in the test channel) and admin alerts; features receive `registrar.slack` and `services.directory`.
- `test/slack/manifests.test.ts`: both manifests point every URL at `/slack/events`, request the same five scopes, subscribe `app_home_opened`, define the `request_pr` shortcut, and use `/nathan` vs `/nathan-staging`.
