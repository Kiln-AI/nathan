---
status: complete
---

# Phase 6: Reminders and drafts

## Overview

Add stale reminders (spec §4.6) and draft nudges (§4.8) to the hourly sweep. After this phase:

- each open, non-draft PR's owners are reminded in the card thread once the PR has sat in its state for a threshold of working hours (weekends excluded in each owner's time zone): 24h by default, configurable per state, 4h with the `urgent` modifier
- a PR with no card gets one at that moment, so every reminder lives in a thread (§4.4)
- after the first reminder, the next comes after another full threshold at one level higher; any state or owner change resets the level
- reminder text comes from configurable templates grouped by level (1, 2, 3, 4+), with several variants per level picked at random, never the variant used last time on that PR; every reminder states the next step and age
- drafts get a DM to their owner at 14 days old, then weekly; draft age is from when the PR was opened or last converted to draft

## Steps

1. **Migration `migrations/0003_pr_reminders.sql`** (additive only, per architecture §9)
   ```sql
   ALTER TABLE pr_prs ADD COLUMN draft_since INTEGER;            -- opened or last converted to draft; null when not a draft
   ALTER TABLE pr_prs ADD COLUMN reminder_levels TEXT NOT NULL DEFAULT '{}';  -- JSON { ownerLogin(lowercase): level }
   ALTER TABLE pr_prs ADD COLUMN reminded_for INTEGER;           -- the state_since the levels belong to
   ALTER TABLE pr_prs ADD COLUMN last_reminder_variant TEXT;     -- "<group>:<variant>"
   ALTER TABLE pr_prs ADD COLUMN draft_nudges INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE pr_prs ADD COLUMN draft_nudged_for INTEGER;       -- the draft_since the count belongs to
   ```
   Levels and nudge counts are tied to the `state_since`/`draft_since` they were sent for, so a state change resets them without the refresh path writing reminder columns.

2. **`src/features/pr_management/config.ts`**
   ```ts
   export const REMINDED_STATES = [...non-final, non-draft states] as const satisfies readonly PRStatusState[];
   export const DEFAULT_REMINDER_TEMPLATES: string[][];   // 4 groups (levels 1, 2, 3, 4+) × 3 variants
   reminders: z.strictObject({
     thresholdHours: z.number().positive().default(24),
     thresholdHoursByState: z.partialRecord(z.enum(REMINDED_STATES), z.number().positive()).default({}),
     urgentThresholdHours: z.number().positive().default(4),
     templates: z.array(z.array(z.string().trim().min(1)).min(1)).min(1).default(DEFAULT_REMINDER_TEMPLATES),
   }).prefault({}),
   drafts: z.strictObject({
     nudgeAfterDays: z.number().int().positive().default(14),
     nudgeEveryDays: z.number().int().positive().default(7),
   }).prefault({}),
   ```
   The last template group repeats for every higher level.

3. **`src/features/pr_management/people.ts`**: add `recipient(login): string | null`, the Slack user ID notified for an owner (the owner, else the triager, else null). `tags` is built on it.

4. **`src/features/pr_management/store.ts`**
   - `PRRecord` gains `draftSince: DateTime | null`, `reminders: ReminderState`, `draftNudges: DraftNudgeState`:
     ```ts
     export interface ReminderState { levels: Record<string, number>; for: DateTime | null; lastVariant: string | null }
     export interface DraftNudgeState { count: number; for: DateTime | null }
     ```
   - `draft_since` joins the refreshed columns.
   - `saveReminders(repo, number, state, expectedVersion): Promise<boolean>` and `saveDraftNudges(repo, number, state, expectedVersion): Promise<boolean>`: compare-and-set on `version`, bumping it, so a reminder computed from a status a refresh has since replaced is never recorded.

5. **`src/features/pr_management/refresh.ts`**
   - `fromPullRequest` sets `draftSince = isDraft ? max(createdAt, lastConvertedToDraftAt) : null`.
   - `postCard` returns the posted `CardLocation`, or null when another refresh holds the lease.
   - `export async function ensureCard(ctx, record, pr): Promise<CardLocation | null>`: the record's card, posting it first when it has none.

6. **`src/features/pr_management/reminders.ts`**
   ```ts
   export function thresholdHours(state, modifiers, config: ReminderConfig): number;  // urgent = min(state threshold, urgent)
   export function currentLevels(record): Record<string, number>;                  // {} when levels belong to an older state
   export interface OwnerWait { login: string; recipient: string; workingHours: number }
   export interface ReminderPlan { recipients: string[]; level: number; levels: Record<string, number> }
   export function planReminder(waits: OwnerWait[], levels, threshold): ReminderPlan | null;
   export function pickTemplate(templates, level, lastVariant, random): { text: string; variant: string };
   export function reminderText(input: { recipients; template; nextStep; waitingHours; ageHours }): string;
   export async function remindIfDue(ctx: PRContext, record: PRRecord, pr: PRData, random: () => number): Promise<void>;
   ```
   - Due level per owner = `floor(workingHours / threshold)`, working hours = `weekendExcludedHours(stateSince, now, tz)` in the recipient's time zone (`directory.timezone`). Owners nobody can be tagged for are skipped.
   - An owner is overdue when their due level is above the level last sent to them. One reply tags every overdue owner (deduped); its level is the highest due level among them. Catching up after downtime sends one reminder at the due level, not several.
   - Flow: plan → `ensureCard` (skip when the lease is held) → `saveReminders` (skip when the record moved on) → post the reply in the card thread; if posting fails, put the previous reminder state back and rethrow, so the next sweep retries.
   - Text: `<tags> — <template>\n*Next step:* <next step> · waiting <time in state> · opened <PR age> ago`.

7. **`src/features/pr_management/drafts.ts`**
   ```ts
   export function draftNudgesDue(draftSince: DateTime, now: DateTime, config: DraftConfig): number;  // 0 before nudgeAfterDays
   export function draftNudgeText(input: { record; days; toAuthor: boolean; people }): string;
   export async function nudgeDraftIfDue(ctx: PRContext, record: PRRecord): Promise<void>;
   ```
   - DM goes to the draft's owner's recipient (the author for team PRs, the triager otherwise). After downtime only one DM is sent.
   - Flow: `saveDraftNudges` first, then DM; a failed DM restores the count and rethrows.
   - Text to the author: "Your draft <link> is N days old — finish it, or close it if it's dead." To the triager: "The draft <link> by <author> is N days old — nudge the author, or close it if it's dead."

8. **`src/features/pr_management/sweep.ts`**: after refreshing each PR the sweep returned, run the follow-up for it in the same isolated step: read the record; drafts → `nudgeDraftIfDue`, other open states → `remindIfDue`. A PR whose refresh fails gets no follow-up that hour. `sweep(ctx, random = Math.random)`.

## Tests

- `test/features/pr_management/reminders.test.ts` (pure)
  - `thresholdHours`: default; per-state override; urgent shortens; urgent never lengthens a shorter state threshold
  - `currentLevels`: kept for the same `stateSince`; empty after a state change or with none sent
  - `planReminder`: nobody due → null; first level due; same level not repeated; next level after another threshold; catch-up jumps to the due level; owners at different levels (only overdue ones tagged, reply at the highest level); recipients deduped
  - `pickTemplate`: level groups and 4+ repeating the last group; avoids the last variant in the same group; may reuse it from another group; single-variant group
  - `reminderText`: tags, template, next step, waiting and age
- `test/features/pr_management/reminders_sweep.test.ts` (through the app's hourly tick)
  - not due before 24 working hours; due at 24 → card posted (PR had none) then a level-1 reply in its thread tagging the owner
  - weekend hours don't count (Friday → Monday in the owner's zone); an owner in another zone uses their own weekend
  - no repeat the next hour; level 2 after another 24h, with a level-2 template
  - a state/owner change resets the level
  - `urgent` reminds after 4h; per-state threshold honoured
  - drafts and merged PRs get no reminders; PRs whose refresh failed get no follow-up
  - unmapped owner → triager tagged; nobody taggable → nothing posted, no card
  - consecutive reminders at the same level avoid the previous variant
  - reply post fails → error reported, levels put back, next sweep sends it
- `test/features/pr_management/drafts.test.ts`
  - `draftNudgesDue`: before 14d, at 14d, at 21d, catch-up count
  - `draftNudgeText` for author and triager
  - sweep: DM at 14 days, not again until 21; converting to draft again restarts the age; OSS draft DMs the triager; failed DM restores the count and is retried; no DM when nobody can be reached
- `test/features/pr_management/config.test.ts`: new defaults; rejects an empty template group, a non-positive threshold, an unknown state threshold
- `test/features/pr_management/people.test.ts`: `recipient`
- `test/features/pr_management/refresh.test.ts`: `draftSince` from opened or converted-to-draft time, null when ready
