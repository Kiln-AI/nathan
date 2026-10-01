---
status: complete
---

# Implementation Plan: Nathan

## Phases

- [x] Phase 1: **Scaffold and platform core.**
  - Tooling: npm, TS strict, Biome with import rules, Vitest workers pool, `wrangler.jsonc` with staging and production envs, CI and deploy workflows.
  - `nathan.config.ts` with zod config, `check:config`, and env overlay.
  - Core services: Clock/time utils, logger, `reportError`, `db` helpers, core D1 migration.
  - HTTP router with `/healthz`, feature model and registrar, queue jobs with retry/give-up/DLQ and debounce, the tz-aware scheduler.
  - Test fakes and fixture builders, and a `docs/setup.md` skeleton.
- [x] Phase 2: **Slack gateway.**
  - `SlackClient` and `SlackRegistry` over slack-edge, with cached authorize and ack/lazy rules.
  - `/nathan` subcommand router and `help`.
  - App Home composition and the directory's tz lookup and cache.
  - Dry-run wrapper, Block Kit helpers, and both Slack manifests.
- [ ] Phase 3: **GitHub gateway.**
  - App auth with a PKCS#8 check and a KV token cache.
  - Webhook verify, delivery dedupe and PR-key extraction (including fork `head_sha`).
  - `PRData` normalization; the sweep, single-PR and recent-PR GraphQL queries; the two-phase `isRequired` check.
  - The writer: `requestReviewers` only.
- [ ] Phase 4: **PR state and sync.**
  - `computeStatus`, covering all §4.2 rules except the merge queue, and the `pr_prs`/`pr_events` schema.
  - Webhook handlers feeding the debounced refresh.
  - The refresh pipeline: create, update and finalize the live card; handoff replies.
  - The hourly sweep, including finalizing PRs that are no longer open.
- [ ] Phase 5: **Request PR flow.**
  - Global shortcut and an App Home button opening the modal.
  - Validation inside the ack budget.
  - `request_review` job: request reviewers, refresh, post/update the card, re-request replies; DM the submitter if it gives up.
- [ ] Phase 6: **Reminders and drafts.**
  - Weekend-excluded due levels per owner time zone, `urgent` threshold.
  - Escalating tone templates with variant rotation, posted in the card thread (creating the card if needed).
  - Draft DM nudges.
- [ ] Phase 7: **Report and personal queue.**
  - Daily report at 09:30 ET weekdays, plus the Monday Trends and People sections and the "Request PR" button.
  - Metrics, Block Kit size-limit splitting.
  - App Home "Waiting on you" / "Your open PRs" section and `/nathan prs`.
- [ ] Phase 8: **Launch readiness.**
  - Complete `docs/setup.md`: Slack and GitHub apps per env, secrets, key conversion, D1/KV/queue creation, inviting Nathan to `#prs`.
  - A `scripts/verify-github.ts` live check: App token, `isRequired`, sweep `rateLimit.cost`.
  - Staging dry-run checklist and the production cutover/retire-old-workflow checklist.
- [ ] Phase 9 (P3): **Merge queue support.** `in_merge_queue` state (no owner, no reminders), with tests.
