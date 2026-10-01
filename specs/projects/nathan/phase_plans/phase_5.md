---
status: complete
---

# Phase 5: Request PR flow

## Overview

Add the Slack entry point for review requests (spec §4.3A). After this phase:

- the "Request PR review" global shortcut (`request_pr`) and a "Request PR" button in the App Home open the request modal: PR link, modifiers (`quick`, `large`, `urgent`), reviewers, note
- submitting validates inside Slack's ack budget and shows inline errors per field (bad link, untracked repo, PR missing or not open, draft, WIP title, unmapped reviewer, author as the only reviewer, GitHub too slow)
- a valid submission is queued durably before the modal closes; the `request_review` job requests the reviewers on GitHub, then the `post_review_request` job refreshes the PR with the form's modifiers, note and submitter, posts the card (first request) or updates it and replies in its thread (re-request)
- if either job gives up, or GitHub rejects the request outright, the submitter gets a DM saying what did and didn't happen

The action ID of the App Home button is exported so the daily report (phase 7) can reuse it.

## Steps

1. **`SlackClient.userName(userId): Promise<string | null>`** (`src/slack/types.ts`, `client.ts`, `dry_run.ts`, `test/fakes/slack.ts`)
   - `users.info` → `profile.display_name || profile.real_name || user.real_name || user.name`, else null.
   - Needed because modal errors are plain text, so "the error names the person" can't use a mention. Dry run passes it through (a read).

2. **`src/features/pr_management/request_form.ts`** (Slack-facing, pure apart from the injected lookups)
   ```ts
   export const REQUEST_PR_SHORTCUT = "request_pr";        // manifest callback_id
   export const REQUEST_PR_VIEW = "request_pr_form";
   export const OPEN_REQUEST_PR_ACTION = "request_pr_open"; // App Home (and later report) button
   export const MODIFIERS = ["quick", "large", "urgent"] as const;
   export const BLOCK = { url: "pr_url", modifiers: "modifiers", reviewers: "reviewers", note: "note" } as const;

   export function requestModal(): ModalView;
   export function readSubmission(values: ViewValues): FormInput;   // { url, modifiers, reviewerIds, note }
   export function parsePullRequestUrl(text: string): { repo: string; number: number } | null;

   export interface ValidationDeps {
     submitterId: string;
     trackedRepo(name: string): string | null;     // configured spelling
     trackedRepos: readonly string[];
     wipTitlePattern: string;
     directory: Pick<UserDirectory, "bySlack">;
     fetchPullRequest(repo: string, number: number): Promise<PRData | null>;
     slackName(userId: string): Promise<string | null>;
     timeoutMs: number;
   }
   export type Validation = { ok: true; request: ReviewRequest } | { ok: false; errors: Record<string, string> };
   export async function validateRequest(input: FormInput, deps: ValidationDeps): Promise<Validation>;
   ```
   - Modal: `url_text_input` (required), checkboxes (optional), `multi_users_select` (required), multiline note (optional, 2000 chars).
   - URL: `http(s)://(www.)github.com/<owner>/<repo>/pull/<n>` with any trailing path, query or fragment; whitespace trimmed.
   - Order: link parse → tracked repo (error lists the tracked repos) → reviewer mapping (all unmapped reviewers named in one error, with how to get added) → GitHub read (only when the link is valid and tracked). The GitHub read and the name lookups for unmapped reviewers run in parallel under one deadline (`REQUEST_VALIDATION_TIMEOUT_MS = 2000`); a timed-out name falls back to the Slack ID.
   - PR checks: not found; merged / closed; draft ("Mark it ready for review on GitHub first."); WIP title ("Title still says WIP. Update it on GitHub first.").
   - Reviewers who are the PR's author are dropped (GitHub rejects requesting the author); if nobody remains the reviewers field errors ("You wrote this PR…" when the submitter is the author, else names the author). This generalizes the spec's "submitter selected only themselves" rule.
   - GitHub timeout → "GitHub didn't answer in time. Try again."; other GitHub errors → logged, "Couldn't reach GitHub. Try again in a minute."
   - `ReviewRequest = { repo, number, reviewers: string[] (GitHub logins, deduped), modifiers, note: string | null, submittedBy }`.

3. **`src/features/pr_management/request.ts`**: the two jobs and messages.
   ```ts
   export const reviewRequestSchema = z.object({ repo, number, reviewers: z.array(z.string()).min(1), modifiers: z.array(z.enum(MODIFIERS)), note: z.string().nullable(), submittedBy: z.string() });
   export async function requestReviewers(ctx, post: JobRef<ReviewRequest>, request): Promise<void>;
   export async function postReviewRequest(ctx, request): Promise<void>;
   export function reRequestReply(input: { request; reviewedBefore: boolean; actor: string; people: People; directory }): string | null;
   export async function onRequestGiveUp(ctx, request, stage: "github" | "slack", error): Promise<void>;
   ```
   - `request_review`: `writer.requestReviewers(repo, number, reviewers)`, then enqueue `post_review_request` with the same payload. A `GitHubApiError` with a 4xx status (not a rate limit) is permanent (e.g. 422 "not a collaborator"): DM the submitter with GitHub's message at once and stop instead of retrying.
   - `post_review_request`: read the record to learn whether the PR already has a card; `refreshPullRequest(ctx, repo, number, undefined, fields)`; if the card already existed, post the re-request reply in its thread. A first request needs no reply: the new card tags the reviewers.
   - Two jobs instead of the architecture's one, so a Slack failure retries only the Slack step and each give-up knows how far the request got: GitHub give-up DM says nothing changed; Slack give-up DM says the reviewers were requested and the hourly sweep will post the card.
   - Reply: `<reviewer tags, minus the submitter> — <actor> re-requested your review 👀.` ("requested" when none of them has reviewed yet), plus the note quoted. The actor is the submitter's GitHub login, else their Slack name, never a mention. Null when nobody is left to tag.

4. **`src/features/pr_management/refresh.ts`**
   - `refreshPullRequest(ctx, repo, number, snapshot?, request?: RequestFields)` where `RequestFields = { modifiers, note, submittedBy }`.
   - With `request`: the record takes the form's modifiers and submitter, and its note when one is given (an empty note keeps the previous one); a card is posted for any open, non-draft PR (not only one with pending reviewers); and the generic handoff reply is skipped (the request job posts its own).

5. **`src/features/pr_management/store.ts`**: `insert` and `update` also write `modifiers`, `note`, `submitted_by`, so the form fields go through the same compare-and-set as the status.

6. **`src/features/pr_management/index.ts`**
   - `shortcut(REQUEST_PR_SHORTCUT, { ack: openView(triggerId, requestModal()) })`.
   - `action(OPEN_REQUEST_PR_ACTION, { ack: same })`.
   - `homeSection({ order: 0, render: one section with a "Request PR" primary button })`.
   - `viewSubmission(REQUEST_PR_VIEW, { ack })`: validate; on errors return them; on success enqueue `request_review` (an enqueue failure becomes an inline error on the link field, so nothing is dropped) and close the modal.
   - Jobs `request_review` and `post_review_request` with `onGiveUp` DMs.

## Tests

- `test/slack/client.test.ts`: `userName` prefers display name, then real name, then username; null when none.
- `test/slack/dry_run.test.ts`: `userName` passes through.
- `test/features/pr_management/request_form.test.ts`
  - `parsePullRequestUrl`: plain, `/files`, query, fragment, `www.`, whitespace; rejects issues, non-GitHub hosts, missing number, repo-only links
  - `readSubmission`: all fields; missing optional fields
  - `requestModal` golden snapshot
  - `validateRequest`: valid request (reviewers mapped to logins, deduped, author dropped); bad link; untracked repo (case-insensitive, configured spelling returned); unmapped reviewers named (two at once, name lookup failing → ID); not found; merged; closed; draft; WIP title; submitter-author as only reviewer; another author as only reviewer; GitHub timeout; GitHub error; several field errors at once; GitHub not called for a bad link
- `test/features/pr_management/request.test.ts` (through the app with FakeSlack/FakeGitHub, signed Slack requests)
  - shortcut opens the modal with the trigger ID; App Home shows the button and the button opens the modal
  - submission with errors returns `response_action: errors` and enqueues nothing
  - valid submission closes the modal and enqueues `request_review` with the parsed payload
  - enqueue failure → inline error
  - `request_review` requests reviewers on GitHub and enqueues `post_review_request`; dry run writes nothing but still posts
  - first request: card posted with modifiers, note and "Requested by" the submitter; no thread reply; record stores the fields
  - re-request: card updated in place with the new modifiers, reply in the thread tagging the reviewers but not the submitter, "re-requested" when they reviewed before, note quoted; no generic handoff duplicate; no second top-level post
  - re-request with no note keeps the previous note
  - GitHub 422 → immediate DM, no retry, no post job
  - GitHub transient failure retries; on the last attempt the submitter is DMed that nothing changed
  - Slack failure retries only the post job; give-up DM says the reviewers were requested
  - end to end: submit → deliver jobs → card in the PR channel, reviewers pending on GitHub
- `test/features/pr_management/refresh.test.ts`: existing behaviour unchanged (generic handoffs still posted without a request).
