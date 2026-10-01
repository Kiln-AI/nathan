import type { DateTime } from "luxon";
import { normalizeGithubLogin } from "../../core/directory";
import type { PRHistory } from "../../github";
import type { PRRecord } from "./store";

// Report metrics (spec §4.7). GitHub has no "time to first review" or "time to merge" field, so
// both are derived from timestamps (research: github-app-integration/metrics.md). Durations are
// wall-clock hours, like the age on a card.

/** A half-open time range, [start, end). */
export interface Window {
  start: DateTime;
  end: DateTime;
}

export interface TrendStats {
  /** Median hours from the review clock start to the first review, for first reviews in the window. */
  firstReviewHours: number | null;
  /** Median hours from the review clock start to merge, for PRs merged in the window. */
  mergeHours: number | null;
  merged: number;
  /** Median age of the PRs open (and not drafts) at the window's end. */
  openAgeHours: number | null;
}

export interface PersonStats {
  login: string;
  /** Open non-draft PRs they wrote. */
  open: number;
  /** Open PRs awaiting their review (they own the next step). */
  reviewsWaiting: number;
  /** PRs they wrote merged since the cutoff. */
  merged: number;
  /** Other people's PRs they submitted a review on since the cutoff. */
  reviewed: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as number) + upper) / 2;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * When the PR last became reviewable: opened, or last marked ready for review. A PR opened as a
 * draft isn't counted slow for its draft time.
 */
export function reviewClockStart(pr: Pick<PRHistory, "createdAt" | "lastReadyForReviewAt">): DateTime {
  const ready = pr.lastReadyForReviewAt;
  return ready && ready > pr.createdAt ? ready : pr.createdAt;
}

/** The first review since the review clock started, by someone other than the author or a bot. */
export function firstReviewAt(pr: PRHistory): DateTime | null {
  const start = reviewClockStart(pr);
  const author = normalizeGithubLogin(pr.author);
  let first: DateTime | null = null;
  for (const review of pr.reviews) {
    const reviewer = review.author;
    if (normalizeGithubLogin(reviewer) === author || reviewer.endsWith("[bot]")) continue;
    if (review.submittedAt < start) continue;
    if (!first || review.submittedAt < first) first = review.submittedAt;
  }
  return first;
}

/**
 * The weekly Trends for team PRs. `records` are the open records now; `history` is every tracked PR
 * updated since well before the window (a PR closed after the window's end was updated then too, so
 * the PRs open at the window's end are today's open ones plus those closed since).
 */
export function trendStats(
  window: Window,
  history: readonly PRHistory[],
  records: readonly PRRecord[],
  isTeam: (login: string) => boolean,
): TrendStats {
  const team = history.filter((pr) => isTeam(pr.author));
  const firstReviews = team.flatMap((pr) => {
    const at = firstReviewAt(pr);
    return at && within(at, window) ? [hoursBetween(reviewClockStart(pr), at)] : [];
  });
  const mergeHours = team.flatMap((pr) =>
    pr.mergedAt && within(pr.mergedAt, window) ? [hoursBetween(reviewClockStart(pr), pr.mergedAt)] : [],
  );

  const openNow = records.filter((record) => record.category === "team" && record.state !== "draft");
  const openKeys = new Set(openNow.map(prKey));
  const closedSince = team.filter((pr) => {
    const closedAt = pr.closedAt ?? pr.mergedAt;
    return !pr.isDraft && closedAt !== null && closedAt >= window.end && !openKeys.has(prKey(pr));
  });
  const openAges = [...openNow, ...closedSince]
    .filter((pr) => pr.createdAt < window.end)
    .map((pr) => hoursBetween(pr.createdAt, window.end));

  return {
    firstReviewHours: median(firstReviews),
    mergeHours: median(mergeHours),
    merged: mergeHours.length,
    openAgeHours: median(openAges),
  };
}

/**
 * The weekly People rows, one per login. "Reviewed" counts PRs rather than reviews: GitHub records
 * a separate review for every reply in a review thread, which would reward chattiness.
 */
export function peopleStats(
  logins: readonly string[],
  records: readonly PRRecord[],
  history: readonly PRHistory[],
  since: DateTime,
): PersonStats[] {
  return logins.map((login) => {
    const key = normalizeGithubLogin(login);
    const is = (other: string) => normalizeGithubLogin(other) === key;
    return {
      login,
      open: records.filter((record) => record.state !== "draft" && is(record.author)).length,
      reviewsWaiting: records.filter((record) => record.state === "awaiting_review" && record.owners.some(is)).length,
      merged: history.filter((pr) => is(pr.author) && pr.mergedAt !== null && pr.mergedAt >= since).length,
      reviewed: history.filter(
        (pr) => !is(pr.author) && pr.reviews.some((review) => is(review.author) && review.submittedAt >= since),
      ).length,
    };
  });
}

export function prKey(pr: { repo: string; number: number }): string {
  return `${pr.repo}#${pr.number}`;
}

function within(time: DateTime, window: Window): boolean {
  return time >= window.start && time < window.end;
}

function hoursBetween(from: DateTime, to: DateTime): number {
  return to.diff(from).as("hours");
}
