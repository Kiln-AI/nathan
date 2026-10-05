---
status: complete
---

# Functional Spec: Nathan

Nathan (`@nathan`) is the team's Slack bot for **deterministic, automatable** work. It is not an AI agent (Claude covers that). V1 delivers a small, extensible platform plus one feature: **PR/CR management**, whose goal is to raise PR-to-merge velocity and stop PRs sitting open.

## 1. Goals and Non-Goals

**Goals**
- Every open, non-draft PR always has exactly one **next step** and at least one **owner**, visible in Slack.
- Owners are told when a PR becomes theirs, and reminded (with escalating, humorous tone) when it sits.
- The team gets a daily view of PR health and a weekly view of whether velocity is improving.
- The codebase is easy for the team (and coding agents) to extend with new features.

**Non-goals (V1)**
- No LLM calls. Behavior is rule-based and predictable.
- No public GitHub comments, and no merging, closing, pushing or approving PRs.
- No review load balancing (deferred).
- No integrations beyond GitHub and Slack (Sentry, PostHog and marketing automation are future features; the platform must make them easy to add, nothing more).

## 2. Why Build, Not Buy

Off-the-shelf options (GitHub's Slack scheduled reminders, Axolo, Graphite, LinearB) each cover part of this, but:
- Our workflow is specific (form-based request, ownership rules, OSS/Dependabot triage, tone escalation), and every tool forces its own model.
- The bot is a long-lived home for *team-specific automation* across many future systems (Sentry, PostHog, marketing). No single vendor covers that.
- In 2026, changing our own small codebase by prompting a coding agent is cheaper than evaluating tools, learning their configuration and clicking through their UIs. The codebase is designed for that: small, conventional and well-tested.

## 3. Platform Capabilities

### 3.1 Feature modules
- Nathan is a host plus a set of **features** (V1 has one: `pr_management`).
- A feature can declare: Slack interactions (shortcuts, modals, buttons, slash subcommands, App Home sections), GitHub webhook handlers, scheduled jobs, and its own config section.
- Each feature can be enabled/disabled in config without code changes.
- Adding a feature should require only adding a new module and registering it. It should not require touching other features.

### 3.2 Shared services available to features
- **GitHub client**: read access to repos, PRs, reviews and checks. Write access is limited to an explicit allow-list (§3.4).
- **Slack client**: post and update messages, open modals, threads, DMs, ephemeral messages, user lookup (including the user's Slack time zone).
- **User directory**: maps Slack users to GitHub users (§6.2).
- **Persistent storage**: small key/record storage for feature state (e.g., PR → Slack thread mapping, reminder counters).
- **Scheduler**: cron-style jobs (e.g., the hourly reminder sweep and the daily report).
- **Time utilities**: "hours elapsed excluding weekends, in time zone X".

### 3.3 Developer experience
- Runs locally against a dev Slack workspace/channel and real or recorded GitHub data.
- **Dry-run mode**: computes and logs everything but posts to a configured test channel instead of real channels, and performs no GitHub writes.
- Core logic (state computation, staleness, report metrics) is pure and unit-testable without Slack or GitHub.

### 3.4 Permissions and safety
- GitHub access is via a GitHub App installed on the org with the narrowest workable permissions: Metadata read, Pull requests read & write, Checks read, Commit statuses read. Pull requests write is used only for the allow-listed operations. See [research](research/platform-stack/summary.md).
- **GitHub write allow-list (V1):** request reviewers, and add labels (the request form's modifiers, §4.3). Nothing else. Anything more is a code-review-gated change to the allow-list.
- Nathan never comments on GitHub in V1. This matters because OSS repos are public.
- All inbound Slack requests and GitHub webhooks are signature-verified.
- Secrets live in the host's secret store, never in the repo.

### 3.5 Hosting constraint
- Preferred: scale-to-zero serverless (Cloudflare Workers or Cloud Run with min instances 0). Fallback: an always-on container on the team's Proxmox box.
- Serverless is viable because Nathan uses Slack's HTTP Events/Interactivity mode, not Socket Mode, and its scheduled jobs are cron-triggered. The hard constraint is Slack's 3-second acknowledgement deadline, so cold-start behavior must be validated. Language (Python preferred, TypeScript acceptable) and host are decided in the architecture step.

## 4. PR Management Feature

### 4.1 Tracked PRs
- A PR is **tracked** if it is open and in a repo on the configured repo list.
- **PR categories**:
  - **Team PR**: the author is in the user directory.
  - **Dependabot PR**: the author is `dependabot[bot]` (configurable list of bot logins).
  - **OSS PR**: anything else (an external contributor).
- **Drafts** are tracked but follow draft rules only (§4.8).

### 4.2 Next step and owner (core model)
Nathan computes a **state**, **next step** and **owner(s)** for every tracked PR from GitHub data. This one computation drives the live thread, handoff notifications, reminders, the personal queue and the report.

Rules are evaluated in order; the first match wins:

| # | Condition | State | Next step | Owner(s) |
|---|-----------|-------|-----------|----------|
| 1 | Merged | `merged` | none | none |
| 2 | Closed unmerged | `closed` | none | none |
| 3 | In a merge queue (P3) | `in_merge_queue` | Wait for merge queue | none |
| 4 | Draft | `draft` | Finish & mark ready | author |
| 5 | Title marks it WIP (non-draft) | `wip_title` | Convert to draft, or drop "WIP" from the title | author |
| 6 | Merge conflict | `conflict` | Resolve conflicts | author |
| 7 | Required CI checks failing | `ci_failing` | Fix CI | author |
| 8 | ≥1 pending requested reviewer | `awaiting_review` | Review | pending reviewers |
| 9 | Any reviewer's latest review is "changes requested" | `changes_requested` | Address feedback & re-request review | author |
| 10 | ≥1 approval | `approved` | Merge | author |
| 11 | Has reviews but none of the above | `needs_rerequest` | Re-request review or merge | author |
| 12 | No reviewers requested, no reviews | `needs_reviewer` | Request a reviewer | author |

- **WIP title:** the title starts with `WIP` (case-insensitive, optionally bracketed or followed by `:`; e.g. `WIP: …`, `[WIP] …`, `(wip) …`). The pattern is configurable. A WIP-titled non-draft PR is a normal tracked PR (card, handoffs, reminders), but the author owns it, so reviewers aren't nagged about it.
- **Merge queue (P3, low priority):** a PR that is in a GitHub merge queue has no owner and gets no reminders. The team doesn't use merge queues yet; build it only if it's cheap, and with tests.

- **Non-team authors:** for OSS and Dependabot PRs, wherever the owner would be "author", it is the **triager** (configurable; initially Daniel). Reviewer-owned steps still go to the reviewers.
- "Required CI checks" means checks marked required by branch protection. If none are required, any failing check counts. CI still running does not count as failing.
- **Team review requests** (requesting a GitHub team rather than a person) are not expanded in V1. If a team is the only pending reviewer, rule 8 treats the PR as having no pending reviewer.
- Nathan does not alter the state for a reviewer who is also the author.

### 4.3 Request PR (taking over the existing Slack workflow)
There are two equivalent entry points, and both end in the same state: reviewers requested on GitHub, plus one Nathan thread in `#prs`.

**A. Slack form (primary)**
- Opened from a **"Request PR" global shortcut**, a button on Nathan's App Home, or a button in the daily report. A global shortcut has no URL, so it can't be a channel bookmark (see [research](research/platform-stack/slack-app-framework/summary.md)). The UX matches today's workflow form.
- Fields:
  - **PR link** (required)
  - **Modifiers** (optional, multi-select): `quick`, `large`, `urgent`. Each is a GitHub label of the same name (see below).
  - **Reviewers** (required, 1+ Slack users)
  - **Note** (optional, free text)
- The PR title is fetched from GitHub, not typed.
- Validation errors are shown inline on the modal field:
  - The link doesn't parse as a GitHub PR URL.
  - The repo isn't tracked.
  - The PR isn't found or isn't open.
  - A selected reviewer has no GitHub mapping. The error names the person and says how to add them (§6.2).
  - The submitter selected only themselves as reviewer (when they are the author).
  - The PR is a **draft**: "Mark it ready for review on GitHub first." Nathan never un-drafts PRs.
  - The PR title marks it **WIP**: "Title still says WIP. Update it on GitHub first."
- On submit: Nathan requests the selected reviewers on GitHub (adding them to any already requested; it never removes anyone), adds the ticked modifiers as labels on the PR (never removing any), then posts or updates the thread (§4.4).
- **Modifiers are GitHub labels.** A PR's modifiers are exactly its labels named `quick`, `large` or `urgent` (any case), however they got there. Nathan only adds them; removing a label on GitHub removes the modifier from the card, the reminders and the Home tab on the next refresh. A re-request with none ticked keeps the PR's labels.
- If the submitter is not the PR author, that is allowed (e.g., a teammate posting on someone's behalf). The thread credits the submitter.

**B. GitHub-originated**
- When reviewers are requested on GitHub for a non-draft tracked PR (or a PR becomes ready-for-review with reviewers already requested), and the PR has no Nathan thread yet, Nathan posts the thread automatically, attributed to the PR author.
- Reviewer-request events are **debounced** (1 minute) so adding reviewers one at a time produces one post.

**Re-requests:** if a PR already has a thread, either entry point updates the existing message and adds a threaded reply. It never makes a duplicate top-level post.

### 4.4 The live CR thread
- There is one top-level message in `#prs` per PR (the "card"). It shows:
  - repo and PR number, title (linked), author, additions/deletions
  - modifiers (the PR's modifier labels) as tags, and the note
  - reviewers with per-reviewer status (pending ⏳, approved ✅, changes requested 🔁, commented 💬)
  - current **state, next step and owner**
  - age
- The card is **edited in place** whenever state changes (reviews, pushes, CI, re-requests, merge, close), so the channel always reflects reality.
- On merge or close, the card shows a final state (🟣 merged / ⚫ closed) and a reaction is added. No further thread activity follows.
- PRs that need a reminder but have no thread (e.g., OSS PRs, team PRs that never requested review) get a card created at that moment. This makes "every reminder lives in a thread" hold true.

### 4.5 Handoff notifications
- When an action changes a PR's **owner(s)**, Nathan posts a threaded reply @-tagging the **new** owner(s) with what happened and what's needed. Examples:
  - "@sam — Alex approved ✅. Ready to merge."
  - "@alex — Sam requested changes 🔁. Over to you."
  - "@sam — Alex re-requested your review."
  - "@alex — CI is failing on your latest push ❌."
- The person who performed the action is never tagged for their own action.
- Notifications within a 60-second window on the same PR are coalesced into one reply showing the final state. A no-op flicker (owner changes and changes back) posts nothing.
- No handoff replies are posted for PRs without a thread, and none for drafts.
- Merge/close post no tag; the card update is enough.

### 4.6 Stale reminders
- **Staleness clock:** hours elapsed since the PR entered its current state and owner set. Weekend hours (Saturday and Sunday in the **owner's** Slack time zone) don't count, so tone doesn't escalate over a weekend nobody worked. Any state or owner change resets the clock and the escalation level.
- **Threshold:** 24 hours (1 day) for all states. The `urgent` modifier (label) shortens this to 4 hours. Thresholds are configurable per state.
- **Delivery:** an hourly sweep posts a threaded reply on the card, @-tagging each overdue owner. Reminders are sent as soon as they're due, at any time of day. Team policy is "send anytime, read when you're working", so there are no quiet hours.
- **Repeat:** after the first reminder, the next is due after another full threshold interval, at an escalation level one higher.
- **Tone escalation:** configurable message templates grouped by level (1, 2, 3, 4+). Each level has several variants, picked at random (avoiding the variant used last time on that PR) so it stays fresh. Level 1 is friendly, and later levels get progressively more pointed and humorous. The highest level repeats indefinitely. Every reminder states the next step and age.
- **Exclusions:** drafts (§4.8) get no stale reminders. OSS and Dependabot PRs get the normal treatment (the triager owns author-side steps).

### 4.7 Daily report
- Posted to `#prs` at **09:30 ET, Mon–Fri**. On Monday it covers the time since Friday's report.
- **Headline:**
  - open non-draft PRs (count and change)
  - opened and merged since last report
  - median and mean age of open PRs
- **Needs attention:** stale PRs (past threshold) grouped by owner, each showing PR, state, next step and age. Sorted oldest first.
- **OSS contributors:** open OSS PRs with state, next step, age and triager.
- **Dependabot:** open Dependabot PRs with state, next step, age and owner. Kept compact: one line per PR.
- **Old drafts:** drafts older than 30 days, with author and age.
- **Weekly sections (Monday only):**
  - **Trends:** this week vs. last week, for team PRs:
    - median time to first review
    - median time to merge
    - PRs merged
    - median open-PR age
  - **People:** per team member:
    - PRs authored and open
    - reviews currently waiting on them
    - PRs merged in the last 7 days
    - reviews submitted in the last 7 days
- Empty sections are omitted. A day with nothing open posts a short "all clear 🎉".

### 4.8 Drafts
- Drafts are excluded from cards, handoffs, stale reminders and the main report sections.
- **Draft age** is measured from when the PR was opened or converted to draft, whichever is later.
- At 14 days, and then weekly, Nathan **DMs** the author: "Your draft X is N days old — finish it, or close it if it's dead." Drafts have no thread, and a channel post would be noise.
- Drafts older than 30 days appear in the daily report's Old drafts section.
- Nathan never closes PRs.

### 4.9 Personal queue
- **App Home tab** (primary). It refreshes when opened, and from a Refresh button left of Request PR that keeps the current tab. The Refresh button's label shows when the tab was last rendered, in the viewer's time zone (e.g. "↻ Refresh · 2:41 PM").
  - **Stats**, each a big number with a breakdown underneath:
    - **Overdue**: unique PRs past their reminder threshold (§4.6), split into PRs waiting on you and your PRs waiting on someone else. It uses the same threshold rule as the daily report's Needs attention section, except that the triager's Overdue also counts Dependabot PRs, which Needs attention leaves to their own section.
    - **Waiting on you**: PRs where you're an owner, counted by your next action.
    - **Open PRs**: PRs you wrote, counted by state.
  - **Tabs**: All, Overdue, Waiting on you and Your open PRs. Overdue filters both sections to overdue PRs and has no section of its own. Opening the tab again starts on All.
  - **Waiting on you**: PRs where you're an owner, grouped by next step, longest waiting first.
  - **Your open PRs**: grouped by state, most action needed first. Each row lists every reviewer with their status, as on the card's Reviewers line (§4.4): ⏳ pending, ✅ approved, 🔁 changes requested, 💬 commented, requested teams marked "(team)" ("⏳ @joe, 🔁 @carol, ✅ @bob"). Dismissed reviews and the author's own are left out, and a reviewer requested again is pending. Anyone else the PR is waiting on who isn't a reviewer (e.g. the triager) is named first, without a status. A PR with neither names nobody.
  - Each row links the PR as "<repo> - #<number>", then shows its title, author and wait. Overdue rows are flagged ⏰. A group shows at most 30 rows, then "…and N more".
- **`/nathan prs`**: posts the All tab as an ephemeral message, without tabs.
- A user with no GitHub mapping sees instructions on how to get added.

## 5. Edge Cases and Error Handling

- **Missed webhooks or downtime:** a reconciliation sweep (hourly, alongside reminders) re-reads tracked PRs from GitHub and corrects state and cards. Webhooks are an optimization; correctness never depends on them.
- **Webhook retries and out-of-order delivery:** handlers are idempotent, and state is always recomputed from GitHub rather than applied incrementally from event payloads.
- **GitHub or Slack API failure during a form submit:**
  - The user gets a clear error.
  - Partial work is reported: if GitHub reviewers were set but the Slack post failed, the user is told; the reconciliation sweep will create the card.
  - Nothing is silently dropped.
- **Untracked repo PR links, non-PR links, closed PRs:** rejected in the form with a specific message.
- **Repo removed from config:** its PRs stop being tracked, and their existing cards are left as-is.
- **User leaves or is unmapped:** their PRs become non-team PRs (triager-owned). Reminders never tag an unmapped user; they fall back to the triager.
- **PR transferred, renamed or force-pushed:** handled by recompute. A force-push doesn't reset the review state that GitHub itself keeps.
- **Rate limits:** GitHub calls are batched and cached per sweep. If a limit is hit, the sweep backs off and the next sweep catches up.
- **Errors in one feature** must not break other features or the host. Errors are logged, and failures of scheduled jobs are reported to a configurable admin channel or DM.

## 6. Configuration

### 6.1 Location and format
- Behavior config lives in a version-controlled file in the repo (reviewed via PR). Secrets are separate (§3.4).
- Config is validated at startup, and invalid config fails fast with a clear message.

### 6.2 Contents (V1)
- **Global:** admin Slack user/channel for errors, dry-run flag, test channel.
- **Users:** list of `{ github_login, slack_user_id }`, with an optional time zone override (the default is the Slack profile time zone).
- **pr_management:**
  - `enabled`
  - `repos`: list of `owner/name`. Easy to add and remove.
  - `channel` (default `#prs`)
  - `triager` (GitHub login; initially Daniel)
  - `bot_authors` (default `["dependabot[bot]"]`)
  - stale thresholds per state, `urgent` threshold
  - report time and time zone
  - draft nudge age (14d) and report age (30d)
  - reminder message templates by escalation level

## 7. Constraints

- **Scale:** a small team (~5–15 people) and a handful of repos. Design for clarity, not throughput.
- **Time zones:** the team spans ET, PT and China. Weekend exclusion uses the owner's time zone. Team-wide events (the report) use ET.
- **Latency:** Slack interactions are acknowledged within 3s; heavy work happens after the ack.
- **Rollout:** the existing Slack Workflow Builder "Request PR" workflow is retired once Nathan's form is live. No migration of old posts is needed.

## 8. Out of Scope (V1)

- Review load balancing / reviewer suggestions
- Reminder snooze button (P2)
- Any LLM-generated content
- GitHub comments, labels (other than adding the modifiers, §4.3), merges, closes and approvals
- Requiring more than one approval
- Non-GitHub integrations (Sentry, PostHog, marketing)
- Expanding GitHub team review requests
- Historical backfill of metrics before Nathan was installed (trends start from data GitHub can provide via API at runtime)
