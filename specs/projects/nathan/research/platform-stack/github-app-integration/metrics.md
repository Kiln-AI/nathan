# Computing Time-to-First-Review and Time-to-Merge (spec §4.7 weekly Trends)

GitHub has no API field for "time to first review" or "time to merge". Both are derived from timestamps. Field names and semantics below are verbatim from the GraphQL schema (`schema.docs.graphql` in github/docs, 2026-10-01). Metric definitions are **[inference / design choice]**: no authoritative standard exists.

## Available timestamps

| Field | Schema text |
|---|---|
| `PullRequest.createdAt` | "Identifies the date and time when the object was created." |
| `PullRequest.mergedAt` | "The date and time that the pull request was merged." |
| `PullRequestReview.submittedAt` | "Identifies when the Pull Request Review was submitted" (nullable; null for `PENDING`) |
| `PullRequestReview.state` | `APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING` |
| `ReadyForReviewEvent.createdAt` | "Represents a 'ready_for_review' event on a given pull request." |
| `ConvertToDraftEvent.createdAt` | "Represents a 'convert_to_draft' event on a given pull request." |
| `ReviewRequestedEvent.createdAt` / `.requestedReviewer` | "Represents an 'review_requested' event on a given pull request." |

All of these are reachable with **Pull requests: read**. REST equivalents are `GET /pulls/{n}/reviews` (`submitted_at`) and `GET /issues/{n}/timeline` (Issues read **or** Pull requests read).

## Suggested definitions

- **Review-clock start (`t0`)**: the time the PR last became reviewable, `max(createdAt, last ReadyForReviewEvent.createdAt)`. PRs opened as drafts would otherwise be penalized for draft time. An alternative is the first `ReviewRequestedEvent` after `t0`, which matches Nathan's "request PR" workflow better but excludes PRs nobody requested review on.
- **Time to first review** = `min(review.submittedAt)` over reviews where `state ≠ PENDING`, `author.login ≠ PR author`, the author isn't a bot, and `submittedAt ≥ t0`, minus `t0`. **[design choice]** Keep DISMISSED reviews; a dismissed review still happened.
- **Time to merge** = `mergedAt − createdAt`, or `mergedAt − t0`. Pick one and label it. Spec §4.7 says "team PRs", so filter by author in the user directory.
- **Weekly bucketing**: bucket by `mergedAt` for time-to-merge and by first-review time for time-to-first-review, in ET (spec §7).
- **Weekend exclusion**: spec §4.6 excludes weekends for staleness only. For trends, decide explicitly whether to reuse the "business hours elapsed" utility. Raw wall-clock medians will jump around holidays.

## Fetching: no backfill store needed

Spec §8 says trends start "from data GitHub can provide via API at runtime". A Monday report needs merged PRs from the last 14 days plus reviews:

```graphql
query Merged($cursor: String) {
  r0: repository(owner:"org", name:"repo-a") {
    pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt mergedAt author { login }
        reviews(first: 20) { nodes { state submittedAt author { login } } }
        timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) { nodes { ... on ReadyForReviewEvent { createdAt } } }
      }
    }
  }
}
```

- `IssueOrderField` only offers `COMMENTS, CREATED_AT, UPDATED_AT`; there's no `MERGED_AT`. So order by `UPDATED_AT DESC` and stop paging once `updatedAt` is older than the window. A merged PR's `updatedAt ≥ mergedAt` **[inference]**, so nothing in the window is skipped.
- Alternative: `search(type: ISSUE, query: "repo:org/a is:pr is:merged merged:>=2026-09-14")` filters server-side but caps at 1,000 results, and `SearchType` has churned recently (see [state-model-data.md](./state-model-data.md)).
- Cost: by the published formula, 1 + 50 × 2 = 101 requests per repo-page, about 1 point. That's negligible.

**People section** ("reviews submitted in the last 7 days" per member) can come from the same data: reviews on PRs updated in the window, grouped by `author.login`. **[inference]** Reviews on still-open PRs need the open-PR sweep data too. A cleaner option is for Nathan to append `pull_request_review.submitted` webhook events to storage as they arrive. With the sweep as backstop, either approach works.

**Median open-PR age** comes from the hourly sweep (`createdAt` of open, non-draft PRs).
