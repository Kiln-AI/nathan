---
status: complete
---

# Phase 9: Merge queue support

## Overview

Spec §4.2 rule 3 (P3): a PR in a GitHub merge queue is in state `in_merge_queue`, next step "Wait for merge queue", with **no owner**, so it gets no reminders and nobody is tagged. It's cheap because everything downstream already reads one computed status:

- GitHub's GraphQL `PullRequest.isInMergeQueue` (a plain boolean, readable with the existing Pull requests read permission) is added to the PR fragment and normalized into `PRData.isInMergeQueue`.
- `computeStatus` gains rule 3 between closed and draft.
- The `pull_request` webhook actions `enqueued` and `dequeued` (already part of the subscribed `pull_request` event) trigger a refresh, so the card updates promptly; the hourly sweep heals anything missed.
- Places that print owners handle an empty owner set (the card, the report's OSS/Dependabot lines, "Your open PRs"), rather than printing "Owners: " with nothing after it.
- Reminders are skipped explicitly for states that aren't reminded (it would already be a no-op with no owners, but the rule should be stated, not incidental).
- Handoffs: entering the queue tags nobody (no owners). Leaving it without merging (dequeued, e.g. the merge group's CI failed or someone removed it) hands the PR back to the author with a dequeue-specific sentence, and the person who dequeued it isn't tagged for their own action. Without this, a dequeue would reuse the "bob approved ✅" sentence for an approval made long before.

No migration: `pr_prs.state` is free text.

## Steps

1. **`src/github/types.ts`**: add to `PRData`:
   ```ts
   /** In a merge queue (spec §4.2 rule 3). */
   isInMergeQueue: boolean;
   ```
2. **`src/github/queries.ts`**: add `isInMergeQueue` to the `PRFields` fragment's scalar list.
3. **`src/github/normalize.ts`**: `RawPullRequest.isInMergeQueue: boolean`; `toPRData` maps it.
4. **Recorded fixtures** (`test/fixtures/github/pull_request.json`, `sweep_page1.json`, `sweep_page2.json`, `sweep_missing_repo.json`): add `"isInMergeQueue": false` to every PR node, except one open PR in `sweep_page1.json` set to `true`.
5. **`test/builders/github.ts`**: `aPR` defaults `isInMergeQueue: false`.
6. **`src/features/pr_management/status.ts`**:
   - `PRStatusState` adds `"in_merge_queue"`.
   - `STATE_INFO.in_merge_queue = { emoji: "🚂", label: "In merge queue", nextStep: "Wait for merge queue" }`.
   - `computeStatus`: after the closed rule, `if (pr.isInMergeQueue) return { state: "in_merge_queue", owners: [] };`. Doc comment updated (owners are empty for merged, closed and in-merge-queue PRs).
7. **`src/features/pr_management/config.ts`**: `REMINDED_STATES` unchanged (it already excludes `in_merge_queue`; that also keeps it out of `thresholdHoursByState`). Add
   ```ts
   export function isReminded(state: PRStatusState): state is RemindedState;
   ```
8. **`src/features/pr_management/reminders.ts`**: `remindIfDue` returns early when `!isReminded(record.state)` (replacing the `draft`/`nextStep === null` check).
9. **`src/features/pr_management/card.ts`**: export
   ```ts
   /** "Owner: a" / "Owners: a, b", or null when nobody owns the PR (merge queue). */
   export function ownersText(labels: readonly string[]): string | null;
   ```
   `statusLine` omits the owner part when it's null.
10. **`src/features/pr_management/report.ts`**: `ownersOf` uses `ownersText`; OSS and Dependabot lines drop the owner detail when null.
11. **`src/features/pr_management/personal_queue.ts`**: "Your open PRs" lines use `ownersText`, dropping the owner part when null.
12. **`src/features/pr_management/handoff.ts`**: in `describeHandoff`, `in_merge_queue` joins draft/final as "no handoff". When `before.state === "in_merge_queue"` (and `after` is open and non-draft), the sentence is `Removed from the merge queue 🚂. Next: <after's next step>.` with the actor from the latest `dequeued` event.
13. **`src/features/pr_management/webhooks.ts`**: add `"enqueued"` and `"dequeued"` to the `pull_request` relevant actions.
14. **`docs/setup.md`**: if it lists the `pull_request` actions/permissions Nathan relies on, note that merge queue state needs no extra permission or event.

## Tests

- `status.test.ts`:
  - rule 3: an open PR in the merge queue is `in_merge_queue` with no owners (team, and OSS: no triager).
  - ordering: merged and closed beat the merge queue; the merge queue beats draft, WIP title, conflict, CI failing and a pending reviewer.
  - `STATE_INFO.in_merge_queue.nextStep` is "Wait for merge queue"; `isFinal` stays false for it.
- `normalize.test.ts` / `reader.test.ts`: the recorded sweep fixture's queued PR normalizes to `isInMergeQueue: true`, others `false`; the PR fragment selects `isInMergeQueue`.
- `handoff.test.ts`:
  - entering the queue posts nothing.
  - leaving it hands back to the author with the dequeue sentence, naming the next step.
  - the author who dequeued it themselves isn't tagged (null).
- `refresh.test.ts`: a carded PR entering the queue updates the card to "In merge queue" with no owner and posts no reply; merging from the queue finalizes as merged.
- `reminders_sweep.test.ts`: a PR waiting in the merge queue far past the threshold gets no reminder and no card.
- `card.test.ts`: the status line for `in_merge_queue` shows the next step and no owner.
- `report.test.ts` / `personal_queue.test.ts`: an OSS/Dependabot PR and the user's own PR in the merge queue print no empty "Owners:"; the queued PR isn't in "Needs attention" or "Waiting on you".
- `webhooks.test.ts`: `enqueued` and `dequeued` debounce a refresh.
