import type { DateTime } from "luxon";

// Normalized GitHub data. Features compute PR state from these, never from webhook payloads.

export type PRState = "open" | "merged" | "closed";

/** GitHub computes mergeability lazily; "unknown" means "not computed yet", not "no conflict". */
export type Mergeable = "mergeable" | "conflicting" | "unknown";

/** "pending" covers queued and running. "neutral" is neither passing nor failing (skipped, neutral, stale). */
export type CheckOutcome = "success" | "failure" | "pending" | "neutral";

export interface Check {
  /** Check run name or commit status context. */
  name: string;
  source: "check_run" | "status";
  outcome: CheckOutcome;
  /**
   * Whether branch protection or a ruleset requires it for this PR. `null` only when no check on
   * the PR is failing: required-ness is resolved (for every check) only for PRs with a failure.
   */
  required: boolean | null;
}

export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed";

export interface Review {
  /** Login; bots as "name[bot]". */
  author: string;
  state: ReviewState;
  submittedAt: DateTime;
}

export interface PRData {
  /** "owner/name". */
  repo: string;
  number: number;
  /** GraphQL node ID. */
  nodeId: string;
  title: string;
  url: string;
  /** Login; bots as "name[bot]" (e.g. "dependabot[bot]"), deleted accounts as "ghost". */
  author: string;
  authorIsBot: boolean;
  state: PRState;
  isDraft: boolean;
  /** Queued in a GitHub merge queue (spec §4.2 rule 3). */
  isInMergeQueue: boolean;
  createdAt: DateTime;
  updatedAt: DateTime;
  mergedAt: DateTime | null;
  closedAt: DateTime | null;
  lastReadyForReviewAt: DateTime | null;
  lastConvertedToDraftAt: DateTime | null;
  additions: number;
  deletions: number;
  baseRef: string;
  headSha: string;
  mergeable: Mergeable;
  /** Users (and bots) whose review is still requested. A reviewer drops off once they review. */
  pendingReviewers: string[];
  /** Requested team slugs. Not expanded to members in V1 (spec §4.2). */
  pendingTeams: string[];
  /** The latest review per reviewer. An approval or change request isn't overridden by a later comment. */
  reviews: Review[];
  /** The latest run per check name and status context on the head commit. */
  checks: Check[];
  /** The head commit has more check contexts than were fetched (100). */
  checksTruncated: boolean;
}

/** A PR as the metrics need it: every submitted review, not just the latest per reviewer. */
export interface PRHistory {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorIsBot: boolean;
  state: PRState;
  isDraft: boolean;
  createdAt: DateTime;
  updatedAt: DateTime;
  mergedAt: DateTime | null;
  closedAt: DateTime | null;
  lastReadyForReviewAt: DateTime | null;
  /** Every submitted review, oldest first. */
  reviews: Review[];
}

export interface SweepResult {
  pullRequests: PRData[];
  /** Configured repos GitHub didn't return (deleted, renamed, or the App isn't installed there). */
  missingRepos: string[];
  /** GraphQL rate-limit points spent. */
  cost: number;
}

/** Read-only GitHub access. Errors: `RateLimitedError`, `GitHubApiError`. */
export interface GitHubReader {
  /** Every open PR (drafts included) in `repos` ("owner/name"), with required checks resolved. */
  openPullRequests(repos: readonly string[]): Promise<SweepResult>;
  /** One PR in any state, or null when it doesn't exist. */
  pullRequest(repo: string, number: number): Promise<PRData | null>;
  /** PRs in any state updated at or after `since`, newest first per repo. */
  recentPullRequests(repos: readonly string[], since: DateTime): Promise<PRHistory[]>;
  /**
   * Open PRs whose head commit is `sha`. Check runs from forks and all commit statuses arrive
   * without a PR number, only the commit.
   */
  openPullRequestsForCommit(repo: string, sha: string): Promise<number[]>;
}

/** The GitHub write allow-list (spec §3.4). Adding a method here is a reviewed change. */
export interface GitHubWriter {
  /** Adds reviewers; never removes anyone. */
  requestReviewers(repo: string, number: number, logins: readonly string[]): Promise<void>;
}

export interface GitHubGateway {
  reader: GitHubReader;
  /** In dry run, a logger that writes nothing. */
  writer: GitHubWriter;
}
