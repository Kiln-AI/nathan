# Research Plan: Platform Stack for Nathan

## Goal

Decide language, framework and libraries for Nathan, the team's Slack bot (project `specs/projects/nathan`). The **architecture** step (Step 4 of `/spec new_project`) is waiting on this. See `../../functional_spec.md` for requirements. The ones that drive this research:

- Slack HTTP mode with a 3-second ack
- GitHub webhooks plus an hourly reconciliation/reminder sweep and a daily cron report
- Small persistent state
- A GitHub App with a narrow write allow-list (request/remove reviewers, mark ready for review)
- **Hosting is decided: Cloudflare Workers.** The user ruled out hosting research; Workers cold starts are well under 3s. Storage will be a Workers-native option (D1/KV/Durable Objects).
- **Language is decided: TypeScript.** Python Workers are too new; the user wants the stable path.

## Run

- Model: same as the current session (Opus-tier; no step-down needed)

## Subtopics

- [x] Slack app framework — Bolt JS and edge-compatible Slack libraries, and the Slack platform features Nathan's UX needs
- [ ] GitHub App integration — permissions, webhooks, APIs and client libraries for Nathan's PR state model

## Focus Details

### Slack app framework

The goal is to identify the best-supported Slack framework **on Cloudflare Workers in TypeScript**:
- Bolt for JS
- Community edge libraries such as `slack-edge` / `slack-cloudflare-workers`
- Bolt "lazy listeners" or the ack-then-process pattern on serverless

Can each run in HTTP mode on Cloudflare Workers? How does the ack-then-process pattern work there (`ctx.waitUntil`, Queues)? Look at maturity and maintenance status.

Then confirm the platform features Nathan's UX needs:
- Global shortcuts and modals, as a replacement for a Workflow Builder form. Also cover whether a Workflow Builder custom step or "function" from our app is a better fit, or whether a shortcut and channel bookmark is simpler.
- Message `chat.update` for live cards, threaded replies with @mentions, App Home tab, slash commands.
- `users.info` time zone, required scopes, rate limits (chat.postMessage / chat.update tiers), and request signature verification.

Out of scope: GitHub, and hosting choices beyond Workers.

### GitHub App integration

Find the exact minimum GitHub App permissions for each of these:
- Read PRs, reviews, requested reviewers, check runs and commit statuses.
- Determine which checks are *required* (branch protection / rulesets API: what permission is needed? Is there a cheaper signal, such as GraphQL `isRequired` on check runs or `mergeStateStatus`?).
- Detect merge conflicts (`mergeable` / `mergeStateStatus`).
- Read org membership to classify external contributors (`author_association`?).
- Request and remove reviewers.
- Mark a draft ready for review (GraphQL `markPullRequestReadyForReview`).

Also cover:
- Which webhook events/actions are needed for the state model (pull_request, pull_request_review, check_suite/check_run, status, etc.).
- Webhook signature verification.
- Efficiently fetching all open PRs and their review/check state across several repos for an hourly sweep (one GraphQL query vs REST fan-out) and rate limits for an App installation.
- Computing time-to-first-review and time-to-merge from API data for weekly trends.
- Client libraries and App JWT/installation-token auth **on Cloudflare Workers**: TypeScript (Octokit, `@octokit/app`, webhook verification via Web Crypto).

Out of scope: Slack, and hosting choices beyond Workers.
