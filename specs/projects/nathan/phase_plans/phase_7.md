---
status: complete
---

# Phase 7: Report and personal queue

## Overview

Add the team-wide and personal views of PR health (spec §4.7, §4.9). After this phase:

- a daily report is posted to the PR channel at 09:30 ET on weekdays (time and zone configurable). It runs the sweep first, so it reports fresh state, then posts:
  - **headline**: open non-draft PRs (count and change since the last report), opened and merged since the last report, median and mean age of open PRs
  - **Needs attention**: stale PRs (an owner past the reminder threshold, weekends excluded in their zone) grouped by owner, oldest first
  - **OSS contributors**, **Dependabot** (one compact line per PR) and **Old drafts** (older than 30 days)
  - on Mondays, **Trends** (team PRs, this week vs last week: median time to first review, median time to merge, PRs merged, median open-PR age) and **People** (per team member: open PRs, reviews waiting on them, merged and reviewed in the last 7 days)
  - a "Request PR" button; empty sections are omitted, and with nothing open the headline says "All clear 🎉"
- a report that outgrows Slack's limits is split: lines are packed into 3000-character sections, and blocks into messages of at most 50, the first top-level and the rest in its thread
- the App Home gains "Waiting on you" (PRs you own, grouped by next step, longest-waiting first) and "Your open PRs" (state and owner); `/nathan prs` replies with the same content as an ephemeral message; unmapped users get instructions

Metrics are wall-clock durations, like the card's age. The report names people by GitHub login without tagging them: reminders already ping, and a daily summary shouldn't.

## Steps

1. **Migration `migrations/0004_pr_reports.sql`**
   ```sql
   CREATE TABLE pr_reports (
     slot INTEGER PRIMARY KEY,      -- the scheduled time it was posted for
     open_count INTEGER NOT NULL,   -- open non-draft PRs, for the next report's change
     posted_at INTEGER NOT NULL
   );
   ```

2. **`src/core/directory.ts`**: `UserDirectory.users(): readonly DirectoryUser[]` (the People section lists every team member). `test/helpers/pr.ts`'s `testPeople` directory gains it.

3. **`src/slack/blocks.ts`** (exported from `index.ts`)
   ```ts
   /** Lines packed into as few sections as fit MAX_SECTION_TEXT, never splitting a line (an overlong one is truncated). */
   export function sectionsFromLines(lines: readonly string[]): SectionBlock[];
   /** Splits blocks into consecutive groups of at most `size` (MAX_MESSAGE_BLOCKS by default). */
   export function chunkBlocks<B>(blocks: readonly B[], size?: number): B[][];
   ```

4. **`src/features/pr_management/config.ts`**
   ```ts
   report: z.strictObject({
     at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:30"),
     timezone: z.string().refine(isValidTimeZone).default("America/New_York"),
   }).prefault({}),
   drafts: { …, reportAfterDays: z.number().int().positive().default(30) },
   ```

5. **`src/features/pr_management/metrics.ts`** (pure)
   ```ts
   export function median(values: readonly number[]): number | null;
   export function mean(values: readonly number[]): number | null;
   /** When the PR last became reviewable: max(createdAt, lastReadyForReviewAt). */
   export function reviewClockStart(pr: PRHistory): DateTime;
   /** The first review by someone other than the author (bots excluded) at or after the review clock start. */
   export function firstReviewAt(pr: PRHistory): DateTime | null;
   export interface Window { start: DateTime; end: DateTime }   // [start, end)
   export interface TrendStats { firstReviewHours: number | null; mergeHours: number | null; merged: number; openAgeHours: number | null }
   /** Team PRs only. `open` is the team's open non-draft PRs now; `history` every PR updated in the last 14 days. */
   export function trendStats(window: Window, history: readonly PRHistory[], open: readonly OpenPR[], isTeam): TrendStats;
   export interface PersonStats { login: string; open: number; reviewsWaiting: number; merged: number; reviewed: number }
   export function peopleStats(logins, records: readonly PRRecord[], history: readonly PRHistory[], since: DateTime): PersonStats[];
   ```
   - Time to first review: bucketed by the first review's time; value = first review − review clock start.
   - Time to merge: bucketed by `mergedAt`; value = `mergedAt` − review clock start (draft time isn't counted against the team).
   - Open-PR age at the window's end: PRs created before it and not closed by then. For last week that's the team's currently open non-draft PRs plus PRs from `history` closed after it (a PR closed after the window end was updated after it, so it's in `history`).
   - People: open = open non-draft PRs authored; reviews waiting = open PRs in `awaiting_review` they own; merged = authored PRs merged since; reviewed = distinct PRs (not their own) they submitted a review on since. Distinct PRs, because GitHub records a separate "commented" review for every reply in a review thread.

6. **`src/features/pr_management/store.ts`**
   ```ts
   lastReport(before: DateTime): Promise<{ slot: DateTime; openCount: number } | null>;
   saveReport(slot: DateTime, openCount: number, postedAt: DateTime): Promise<void>;   // upsert
   ```

7. **`src/features/pr_management/report.ts`**
   ```ts
   export interface ReportInput {
     slot: DateTime; now: DateTime; since: DateTime; timezone: string; weekly: boolean;
     previousOpenCount: number | null;
     records: PRRecord[];                       // open (non-final) records, drafts included
     overdue: ReadonlyMap<string, string[]>;    // "<repo>#<n>" → owners past their threshold
     history: PRHistory[];
     team: string[];                            // GitHub logins, for People
     triager: string; isTeam(login): boolean; oldDraftDays: number;
   }
   export interface ReportMessage { text: string; blocks: MessageBlock[] }
   export function buildReport(input: ReportInput): ReportMessage[];   // pure; first message top-level, rest threaded
   export async function postDailyReport(ctx: PRContext, slot: DateTime): Promise<void>;
   ```
   - `postDailyReport`: run `sweep(ctx)` (a failure is reported and the report goes ahead from the stored records); read the open records; `since` = the last stored report's slot, else the previous scheduled slot; read `recentPullRequests(repos, min(since, now − 14d on Mondays))`; work out overdue owners (`thresholdHours`, `weekendExcludedHours` from `stateSince` in each owner's recipient's zone, the report zone when nobody can be told); build; post the first message to `config.channel`, store the report row, post the rest in its thread.
   - Sections are line lists rendered with `sectionsFromLines` under a bold heading; the header, headline and Request PR button lead the first message; `chunkBlocks` splits the rest.
   - Monday is the slot's weekday in the report zone.
   - Needs attention, OSS and Dependabot cover non-draft PRs. Needs attention leaves out Dependabot PRs, which have their own compact section.

8. **`src/features/pr_management/personal_queue.ts`**
   ```ts
   export function personalQueueBlocks(input: { login: string | null; records: readonly PRRecord[]; now: DateTime; people: People }): MessageBlock[];
   export function registerPersonalQueue(registrar: Registrar<PRConfig>, ctx: PRContext): void;
   ```
   - Waiting on you: open non-draft records the login owns (case-insensitive), grouped by next step, groups and items ordered by `stateSince` ascending; each line has the link, title and time waiting.
   - Your open PRs: open records the login authored (drafts included), oldest first, with state, owners and age.
   - Unmapped: "I don't know your GitHub login yet…" with how to get added.
   - Home section (order 10) reads D1 when the tab opens; `/nathan prs` (lazy) responds with the blocks, capped at 50 with a note pointing to the App Home.

9. **`src/features/pr_management/index.ts`**: schedule `daily_report` at `config.report.at` in `config.report.timezone` on weekdays → `postDailyReport(ctx, firedAt)`; `registerPersonalQueue`.

## Tests

- `test/slack/blocks.test.ts`: `sectionsFromLines` packs lines, starts a new section at the limit, truncates an overlong line, empty → none; `chunkBlocks` splits at 50 and keeps order
- `test/features/pr_management/metrics.test.ts` (pure, 100% branches)
  - `median`/`mean`: empty, odd, even
  - `reviewClockStart`: created only; ready-for-review later
  - `firstReviewAt`: author's own and bot reviews ignored; reviews before ready ignored; earliest wins; none → null
  - `trendStats`: first review bucketed by review time; merge time from the review clock start; merged count per window; non-team PRs ignored; open age now vs at last week's end (closed-after PRs counted, PRs created after excluded); empty window → nulls
  - `peopleStats`: each count; own-PR reviews and old activity excluded; distinct PRs reviewed; logins matched case-insensitively
- `test/features/pr_management/report.test.ts`
  - `buildReport` golden file snapshots: a busy Monday (every section), a quiet day (all clear)
  - headline: change vs previous count (+, −, none, no previous); opened/merged since; median/mean age
  - Needs attention grouped by owner, oldest first; non-overdue and Dependabot PRs left out; drafts in Old drafts only past 30 days
  - empty sections omitted; weekly sections only when `weekly`
  - splitting: a report with many stale PRs splits into messages of ≤ 50 blocks, each section ≤ 3000 chars
  - through the scheduler: posts at 09:30 Toronto on a weekday (13:30 UTC in EDT), not at weekends; runs the sweep first (records refreshed and card posted); stores the report and uses its count next day; Monday covers since Friday and includes Trends and People; a failing sweep still posts; overdue owners use their own zones; continuation messages in the thread; the Request PR button opens the form
- `test/features/pr_management/personal_queue.test.ts`
  - grouping by next step and ordering; drafts excluded from Waiting on you but listed in Your open PRs; case-insensitive login match; final records ignored; empty states; unmapped user instructions; golden snapshot
  - App Home opened → published home contains both sections after the Request PR section
  - `/nathan prs` → ephemeral reply with the same blocks; capped at 50 blocks with the note
- `test/features/pr_management/config.test.ts`: report defaults; bad time or zone rejected; `reportAfterDays` default
- `test/core/directory.test.ts`: `users()` lists the config users
