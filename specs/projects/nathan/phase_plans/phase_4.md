---
status: complete
---

# Phase 4: PR state and sync

## Overview

Add the `pr_management` feature with its core loop: GitHub data in, one live Slack card per PR out. After this phase:

- `computeStatus` (pure) gives every tracked PR a state, next step and owner(s) per spec §4.2, rules 1–12 except the merge queue (rule 3, phase 9)
- `pr_prs` stores Nathan's own facts per PR (last computed status and when it started, card location, last known mergeability, head SHA, modifiers/note/submitter for phase 5); `pr_events` logs webhook events so a refresh can say who did what
- webhook handlers record events and debounce a refresh per PR (60s window, 300s max wait); check/status events without a PR number are mapped through the stored head SHA, else resolved through `reader.openPullRequestsForCommit` in a debounced job
- the refresh pipeline recomputes from GitHub, stores the status with optimistic concurrency, then applies effects: edit the card in place, create it for GitHub-originated review requests (§4.3B), add the final reaction on merge/close, and post handoff replies (§4.5)
- an hourly sweep refreshes every open PR from one GraphQL sweep and finalizes stored PRs that are no longer open

The feature is registered in `src/features/index.ts`; `nathan.config.ts` gets a disabled `pr_management` section with setup placeholders (phase 8 enables it).

## Steps

1. **`migrations/0002_pr_management.sql`**
   ```sql
   CREATE TABLE pr_prs (
     repo TEXT NOT NULL, number INTEGER NOT NULL,
     title TEXT NOT NULL, url TEXT NOT NULL, author TEXT NOT NULL,
     category TEXT NOT NULL,              -- team | dependabot | oss
     created_at INTEGER NOT NULL,         -- PR opened (ms)
     is_draft INTEGER NOT NULL,
     additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
     head_sha TEXT NOT NULL,
     mergeable TEXT NOT NULL,             -- last known value; "unknown" never overwrites a known one
     state TEXT NOT NULL,                 -- computeStatus state
     owners TEXT NOT NULL,                -- JSON array of GitHub logins, sorted
     state_since INTEGER NOT NULL,        -- when state or owners last changed (staleness clock)
     modifiers TEXT NOT NULL DEFAULT '[]', note TEXT, submitted_by TEXT,   -- written by the request form (phase 5)
     card_channel TEXT, card_ts TEXT, card_hash TEXT, card_claimed_at INTEGER,
     refreshed_at INTEGER NOT NULL,
     version INTEGER NOT NULL,            -- optimistic concurrency between refreshes
     PRIMARY KEY (repo, number)
   );
   CREATE INDEX pr_prs_head ON pr_prs (repo, head_sha);
   CREATE INDEX pr_prs_state ON pr_prs (state);
   CREATE TABLE pr_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     repo TEXT NOT NULL, number INTEGER NOT NULL,
     event TEXT NOT NULL, action TEXT, actor TEXT,
     subject TEXT,                        -- requested reviewer, or submitted review state
     received_at INTEGER NOT NULL
   );
   CREATE INDEX pr_events_pr ON pr_events (repo, number, id);
   ```

2. **`src/features/pr_management/config.ts`**
   ```ts
   export const DEFAULT_WIP_TITLE_PATTERN = String.raw`^\s*[\[(]?wip\b`;
   export const prConfigSchema = z.strictObject({
     repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).min(1),   // unique, case-insensitive
     channel: slackChannelId,
     triager: z.string().min(1),
     botAuthors: z.array(z.string()).default(["dependabot[bot]"]),
     wipTitlePattern: z.string().default(DEFAULT_WIP_TITLE_PATTERN).refine(isValidRegex),   // matched case-insensitively
   });
   export type PRConfig = z.output<typeof prConfigSchema>;
   declare module "../../core/config" { interface FeatureSectionInputs { pr_management: z.input<typeof prConfigSchema> } }
   ```
   Reminder, report and draft settings arrive with their phases.

3. **`src/features/pr_management/status.ts`** (pure)
   ```ts
   export type PRStatusState = "merged" | "closed" | "draft" | "wip_title" | "conflict" | "ci_failing"
     | "awaiting_review" | "changes_requested" | "approved" | "needs_rerequest" | "needs_reviewer";
   export type PRCategory = "team" | "dependabot" | "oss";
   export interface PRStatus { state: PRStatusState; owners: string[] }   // owners: sorted, unique
   export const STATE_INFO: Record<PRStatusState, { emoji: string; label: string; nextStep: string | null }>;
   export function categorize(author: string, deps: { isTeamMember(login): boolean; botAuthors: readonly string[] }): PRCategory;
   export function isWipTitle(title: string, pattern: string): boolean;
   export function effectiveMergeable(current: Mergeable, lastKnown: Mergeable | undefined): Mergeable;
   export function isCiFailing(checks: readonly Check[]): boolean;
   export function computeStatus(pr: PRData, ctx: { category: PRCategory; triager: string; wipTitlePattern: string; lastKnownMergeable?: Mergeable }): PRStatus;
   export function isFinal(state): boolean;  export function sameOwners(a, b): boolean;
   ```
   - Rules in order: merged, closed, draft, WIP title, conflict, CI failing, pending reviewer (users and bots only; teams ignored), any latest review "changes requested", any approval, any review, else needs reviewer.
   - Author-side owner is the author for team PRs and the triager for Dependabot/OSS PRs; reviewer-side owners are the pending reviewers.
   - Reviews by the PR author (e.g. the review GitHub creates when the author replies to a comment) are ignored, per "Nathan does not alter the state for a reviewer who is also the author". Dismissed reviews count only for rule 11.
   - CI failing: a check with outcome `failure` that is required; when no check is required (all `false`/`null`), any failure counts. Pending never counts.
   - `mergeable: "unknown"` falls back to the last stored value, and counts as no conflict when there is none.

4. **`src/features/pr_management/people.ts`**
   ```ts
   export interface People {
     /** "<@U…>" for a mapped login, else the plain login. Used on cards and for actor names. */
     label(login: string): string;
     /** Mentions to tag for these owners: unmapped owners fall back to the triager (spec §5); deduped; empty when nobody is taggable. */
     tags(logins: readonly string[]): string[];
   }
   export function createPeople(directory: UserDirectory, triager: string): People;
   ```

5. **`src/features/pr_management/store.ts`**: plain SQL over `services.db`.
   ```ts
   export interface PRRecord { repo; number; title; url; author; category; createdAt: DateTime; isDraft; additions; deletions; headSha;
     mergeable: Mergeable; state: PRStatusState; owners: string[]; stateSince: DateTime;
     modifiers: string[]; note: string | null; submittedBy: string | null;
     card: { channel: string; ts: string } | null; cardHash: string | null; refreshedAt: DateTime; version: number }
   export interface PREvent { id; event; action; actor; subject; receivedAt }
   export function createPRStore(db: Db): {
     get(repo, number): Promise<PRRecord | null>;
     insert(record): Promise<boolean>;                         // false if another refresh inserted first
     update(record, expectedVersion): Promise<boolean>;        // compare-and-set on version
     restoreStatus(previous: PRRecord, version): Promise<void>; // undo a status write whose effects failed
     claimCard(repo, number, now, staleBefore): Promise<boolean>;
     saveCard(repo, number, card, hash): Promise<void>; releaseCard(repo, number): Promise<void>; saveCardHash(...)
     openNumbersForHead(repo, sha): Promise<number[]>;
     setHeadSha(repo, number, sha): Promise<void>;
     openRecords(repos): Promise<PRRecord[]>;                   // non-final, in the given repos
     recordEvent(repo, number, event): Promise<void>; events(repo, number): Promise<PREvent[]>;
     deleteEvents(repo, number, upToId): Promise<void>; pruneEvents(before): Promise<void>;
   }
   ```

6. **`src/features/pr_management/card.ts`** (pure)
   ```ts
   export interface CardModel { repo; number; title; url; author; additions; deletions; createdAt; state; owners; reviewers: ReviewerLine[];
     modifiers; note; submittedBy: string | null }
   export interface ReviewerLine { login: string; status: "pending" | "approved" | "changes_requested" | "commented"; team?: boolean }
   export function reviewerLines(pr: PRData): ReviewerLine[];   // pending (users, then teams) ⏳; else latest review; dismissed and author's own omitted
   export function renderCard(model: CardModel, people: People, now: DateTime): { text: string; blocks: MessageBlock[] };
   ```
   - Blocks: title section (`*<url|repo#n>* title`), context (author, `+adds −dels`, age, modifier tags), optional note (quoted), reviewers section (⏳ ✅ 🔁 💬), status section (emoji, label, next step, owners), context crediting the submitter (or the author for GitHub-originated cards). Final states show 🟣 Merged / ⚫ Closed and no next step or owner.
   - Text fallback: `repo#n title: <state label>`.

7. **`src/features/pr_management/handoff.ts`** (pure)
   ```ts
   export function describeHandoff(input: { before: PRStatus; after: PRStatus; pr: PRData; events: PREvent[]; people: People }): string | null;
   ```
   - Null unless the owner set changed, the new state isn't draft/merged/closed, and some new owner (in `after` but not `before`) remains after removing the actor.
   - The actor and message come from the new state: `approved` / `changes_requested` / `needs_rerequest` → the newest such review's author ("bob approved ✅. Ready to merge." / "bob requested changes 🔁. Over to you." / "bob reviewed 💬. Re-request review or merge."); `awaiting_review` → the newest `review_requested` event's sender ("re-requested" if the tagged reviewer has reviewed before), else a `ready_for_review` sender, else no actor; `ci_failing`, `conflict`, `needs_reviewer`, `wip_title` → fixed sentences with the next step.
   - Format: `<tags> — <sentence>`, actors named with `people.label` minus the ping (plain login), so the actor is never tagged.

8. **`src/features/pr_management/refresh.ts`**
   ```ts
   export interface PRContext { config: PRConfig; services: Services; store: PRStore; people: People }
   export async function refreshPullRequest(ctx, repo, number, fetched?: PRData | null): Promise<void>;
   ```
   - Fetch the PR unless given (`null` = vanished). Read the record and the PR's events; compute the status; write the record (insert, or compare-and-set update; re-read and recompute up to 3 times on a lost race). `state_since` resets only when state or owners change.
   - A vanished PR whose record is open is finalized as `closed`, rendering the card from the record. A vanished PR with no record, or an already-final one, only consumes its events.
   - Effects after the write:
     - card exists → re-render, `updateMessage` only if the content hash changed; on entering merged/closed add `large_purple_circle` / `black_circle`; then the handoff reply (`describeHandoff`) in the card thread. A card created in this refresh gets no handoff: the card itself tags the reviewers.
     - no card, PR open, not a draft, users or teams requested → claim (`card_claimed_at`, 5-minute lease), post to `config.channel`, save `{channel, ts}` and hash; release the claim on failure.
   - If an effect throws, restore the previous record's status (state, owners, `state_since`) when the record existed, and rethrow, so the job retry sees the same change and redoes the effects; card posting and updating are idempotent through the hash and the claim.
   - Consume the events read (delete up to the max id) after effects succeed.

9. **`src/features/pr_management/webhooks.ts`**
   - One handler for all four events. Ignore untracked repos (case-insensitive match against `config.repos`, mapped to the configured spelling) and irrelevant actions (`pull_request`: opened, reopened, closed, converted_to_draft, ready_for_review, review_requested, review_request_removed, synchronize, edited; `pull_request_review`: submitted, dismissed, edited; all `check_run` and `status`).
   - PR numbers from the event; when empty, from `store.openNumbersForHead(repo, headSha)`; when still empty, `debounce(resolveCommit, "<repo>@<sha>", { repo, sha }, 60s/300s)`.
   - Per PR: `recordEvent` (subject = `requested_reviewer.login` or the review state), `setHeadSha` for `pull_request` events, then `debounce(refresh, "<repo>#<n>", { repo, number }, { windowSeconds: 60, maxWaitSeconds: 300 })`.

10. **`src/features/pr_management/sweep.ts`**
    - `reader.openPullRequests(config.repos)`; missing repos are reported once (`reportError`, deduped hourly).
    - Refresh each returned PR with its fetched data; a failure is reported and the sweep continues with the next PR, except `RateLimitedError`, which aborts the sweep (the next one catches up).
    - Stored open records in configured, non-missing repos that the sweep didn't return are re-read with `reader.pullRequest` and refreshed (finalizing merged/closed/vanished).
    - Prune `pr_events` older than 7 days.

11. **`src/features/pr_management/index.ts`**
    - `prManagement = defineFeature({ id: "pr_management", configSchema: prConfigSchema, register })`.
    - Jobs: `refresh` `{ repo, number }`, `resolve_commit` `{ repo, sha }` (finds open PRs for the commit and debounces their refresh). Webhooks: the four events. Schedule: `sweep` every hour.
    - Warns at startup when the triager has no Slack mapping (they can't be tagged).
    - `src/features/index.ts`: `[prManagement]`. `nathan.config.ts`: a disabled `pr_management` section with placeholder repos, channel and triager.

12. **Test infrastructure**: `test/helpers/pr.ts` with `prApp(overrides)` (testApp with the feature enabled and a config builder), and helpers to run the refresh job and read records.

## Tests

- `test/features/pr_management/status.test.ts` (100% branches)
  - each rule 1–12 in isolation, and precedence between neighbours (merged beats draft, draft beats WIP, WIP beats conflict, conflict beats CI, CI beats pending reviewer, pending reviewer beats changes requested, changes requested beats approval, approval beats comment-only)
  - owners: team author; Dependabot and OSS author-side steps go to the triager; reviewer steps go to the pending reviewers; sorted and deduped
  - team-only review request falls through to rule 11/12; bot reviewers count
  - author's own reviews ignored; dismissed-only reviews → needs_rerequest
  - CI: required failure counts; non-required failure ignored when something is required; any failure when nothing required; `required: null` treated as not required; pending never failing
  - mergeable unknown uses the last known value; unknown with none → no conflict
  - WIP: `WIP: x`, `[WIP] x`, `(wip) x`, `wip x` match; `Wipe the cache`, `Fix WIP handling` don't; custom pattern
  - categorize: bot list (case-insensitive, with/without `[bot]`), team member, OSS
- `test/features/pr_management/card.test.ts`: golden file snapshots for an awaiting-review team card, an OSS card with modifiers, note and submitter, merged and closed finals; reviewer lines (pending, re-requested after review, approved, changes requested, commented, dismissed omitted, teams); unmapped people as plain logins; title escaping
- `test/features/pr_management/handoff.test.ts`: each example in spec §4.5 (approved, changes requested, re-requested, CI failing); first request vs re-request; ready-for-review actor; no actor event; actor never tagged (self-requested reviewer → null); unchanged or shrinking owners → null; draft/merged/closed → null; unmapped owner falls back to the triager; nobody taggable → null
- `test/features/pr_management/people.test.ts`: label and tags (mapped, unmapped → triager, unmapped triager, dedupe)
- `test/features/pr_management/config.test.ts`: defaults; invalid repo, channel name and regex rejected; duplicate repos rejected
- `test/features/pr_management/refresh.test.ts` (through the app with FakeGitHub/FakeSlack)
  - first refresh inserts the record; `state_since` kept when unchanged, reset on state or owner change
  - card created for a PR with requested reviewers (users or teams), not for drafts, not without reviewers; posted once even when two refreshes race (claim); claim released when posting fails
  - card edited in place on change; no `chat.update` when the rendered card is unchanged
  - merge/close: final card, one reaction, no handoff; reopen re-activates the card
  - handoff reply in the thread on owner change; none without a card; coalesced flicker posts nothing
  - mergeable unknown keeps the stored value
  - vanished PR finalized as closed from the record; vanished untracked PR is a no-op
  - Slack failure during the handoff restores the previous status so the retry posts it once
  - lost compare-and-set race recomputes from the fresh record
  - events consumed after a successful refresh
- `test/features/pr_management/webhooks.test.ts` (signed requests through `app.fetch`)
  - pull_request review_requested → event recorded with subject, head SHA stored, debounced refresh enqueued with 60s delay; untracked repo and irrelevant action ignored
  - repo matching is case-insensitive and stored with the configured spelling
  - status / fork check_run mapped through the stored head SHA; unknown SHA enqueues `resolve_commit`; `resolve_commit` debounces refreshes for the PRs GitHub returns
  - end to end: webhook → debounced job delivered → card posted
- `test/features/pr_management/sweep.test.ts`
  - refreshes every open PR (creating cards where due) without per-PR GitHub calls
  - stored open PR missing from the sweep is re-read and finalized (merged → 🟣 card + reaction)
  - missing repos reported; their stored PRs left alone
  - one PR failing (Slack error) doesn't stop the others; a rate limit aborts the sweep
  - old events pruned
  - runs from the scheduler at the top of the hour
- `test/features/index.test.ts` or app test addition: the shipped `nathan.config.ts` still loads for every environment with the feature registered
