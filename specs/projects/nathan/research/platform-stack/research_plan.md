# Research Plan: Platform Stack for Nathan

## Goal

Decide hosting, language, framework and storage for Nathan, the team's Slack bot (project `specs/projects/nathan`). The **architecture** step (Step 4 of `/spec new_project`) is waiting on this. See `../../functional_spec.md` for requirements. The ones that drive this research:

- Slack HTTP mode with a 3-second ack
- GitHub webhooks plus an hourly reconciliation/reminder sweep and a daily cron report
- Small persistent state
- A GitHub App with a narrow write allow-list (request/remove reviewers, mark ready for review)
- The user prefers Python, but TypeScript is fine if it enables good serverless hosting
- Hosting preference: Cloudflare Workers or Cloud Run scale-to-zero, with a Proxmox box as fallback

## Run

- Model: same as the current session (Opus-tier; no step-down needed)

## Subtopics

- [ ] Serverless hosting — Cloudflare Workers vs Cloud Run (scale to zero) vs always-on container, for a Slack + GitHub webhook bot with cron jobs and small state
- [ ] Slack app framework — Bolt (Python/JS) and edge-compatible Slack libraries, and the Slack platform features Nathan's UX needs
- [ ] GitHub App integration — permissions, webhooks, APIs and client libraries for Nathan's PR state model

## Focus Details

### Serverless hosting

Compare Cloudflare Workers (TypeScript and Python Workers, as of late 2026) against Google Cloud Run with min-instances 0, plus an always-on Docker container as the baseline.

Areas to cover:
- **Workers features:** cron triggers, `waitUntil` / Queues for work after the 3s ack, storage options (D1, KV, Durable Objects) and their fit for small relational state, Python Workers maturity (Pyodide, package support, cold start, production readiness).
- **Cloud Run:** realistic Python cold-start latency against Slack's 3s ack deadline; mitigations such as CPU boost, ack-then-Cloud-Tasks, or min-instances 1 and its cost; Cloud Scheduler for cron; storage (Firestore, Cloud SQL, SQLite on GCS-backed volumes); CPU throttling after the response.
- **Cross-cutting:** cost at tiny scale, local dev experience, deploy story, secrets, logging.

Out of scope: Slack library specifics (Slack subtopic) and GitHub API specifics (GitHub subtopic), except where they constrain the host. Example: whether Bolt Python runs on Workers at all belongs to the Slack subtopic, so note any host-side constraint only.

### Slack app framework

The goal is to identify the best-supported Slack framework for each candidate stack:
- Bolt for Python and Bolt for JS
- Community edge libraries such as `slack-edge` / `slack-cloudflare-workers`
- Bolt "lazy listeners" or the ack-then-process pattern on serverless

Can each run in HTTP mode on Cloudflare Workers and on Cloud Run? Look at maturity and maintenance status.

Then confirm the platform features Nathan's UX needs:
- Global shortcuts and modals, as a replacement for a Workflow Builder form. Also cover whether a Workflow Builder custom step or "function" from our app is a better fit, or whether a shortcut and channel bookmark is simpler.
- Message `chat.update` for live cards, threaded replies with @mentions, App Home tab, slash commands.
- `users.info` time zone, required scopes, rate limits (chat.postMessage / chat.update tiers), and request signature verification.

Out of scope: hosting cost and GitHub.

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
- Client libraries and App JWT/installation-token auth in TypeScript (Octokit, including on Workers) and Python (githubkit, PyGithub).

Out of scope: Slack and hosting.
