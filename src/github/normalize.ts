import { DateTime } from "luxon";
import type { Check, CheckOutcome, Mergeable, PRData, PRHistory, PRState, Review, ReviewState } from "./types";

// Raw GraphQL shapes (only the selected fields; see queries.ts) and their mapping to PRData.

export interface RawActor {
  __typename: string;
  login: string;
}

export interface RawReview {
  state: string;
  submittedAt: string | null;
  author: RawActor | null;
}

export interface RawCheckRun {
  __typename: "CheckRun";
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  isRequired?: boolean;
}

export interface RawStatusContext {
  __typename: "StatusContext";
  context: string;
  state: string;
  createdAt: string;
  isRequired?: boolean;
}

export type RawCheckContext = RawCheckRun | RawStatusContext;

export interface RawCommits {
  nodes: {
    commit: {
      statusCheckRollup: {
        contexts: { pageInfo: { hasNextPage: boolean }; nodes: (RawCheckContext | null)[] };
      } | null;
    };
  }[];
}

export interface RawRequestedReviewer {
  __typename: string;
  login?: string;
  slug?: string;
}

export interface RawPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  baseRefName: string;
  headRefOid: string;
  mergeable: string;
  author: RawActor | null;
  reviewRequests: { nodes: ({ requestedReviewer: RawRequestedReviewer | null } | null)[] };
  latestOpinionatedReviews: { nodes: (RawReview | null)[] };
  latestReviews: { nodes: (RawReview | null)[] };
  timelineItems: { nodes: ({ __typename: string; createdAt?: string } | null)[] };
  commits: RawCommits;
}

export interface RawPullRequestHistory {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author: RawActor | null;
  reviews: { nodes: (RawReview | null)[] };
  timelineItems: { nodes: ({ createdAt?: string } | null)[] };
}

/** GitHub shows deleted accounts as "ghost". */
export const GHOST_LOGIN = "ghost";

/** GraphQL names bots without the "[bot]" suffix that REST, webhooks and config use. */
export function normalizeLogin(actor: { __typename: string; login?: string } | null): string {
  if (!actor?.login) return GHOST_LOGIN;
  return actor.__typename === "Bot" && !actor.login.endsWith("[bot]") ? `${actor.login}[bot]` : actor.login;
}

export function toPRData(repo: string, raw: RawPullRequest): PRData {
  const contexts = raw.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
  const timeline = lastTimelineTimes(raw.timelineItems.nodes);
  const { users, teams } = toPendingReviewers(raw.reviewRequests.nodes);
  return {
    repo,
    number: raw.number,
    nodeId: raw.id,
    title: raw.title,
    url: raw.url,
    author: normalizeLogin(raw.author),
    authorIsBot: raw.author?.__typename === "Bot",
    state: toPRState(raw.state),
    isDraft: raw.isDraft,
    createdAt: time(raw.createdAt),
    updatedAt: time(raw.updatedAt),
    mergedAt: optionalTime(raw.mergedAt),
    closedAt: optionalTime(raw.closedAt),
    lastReadyForReviewAt: timeline.ReadyForReviewEvent,
    lastConvertedToDraftAt: timeline.ConvertToDraftEvent,
    additions: raw.additions,
    deletions: raw.deletions,
    baseRef: raw.baseRefName,
    headSha: raw.headRefOid,
    mergeable: toMergeable(raw.mergeable),
    pendingReviewers: users,
    pendingTeams: teams,
    reviews: toLatestReviews(raw.latestOpinionatedReviews.nodes, raw.latestReviews.nodes),
    checks: toChecks(contexts?.nodes ?? []),
    checksTruncated: contexts?.pageInfo.hasNextPage ?? false,
  };
}

export function toPRHistory(repo: string, raw: RawPullRequestHistory): PRHistory {
  return {
    repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: normalizeLogin(raw.author),
    authorIsBot: raw.author?.__typename === "Bot",
    state: toPRState(raw.state),
    isDraft: raw.isDraft,
    createdAt: time(raw.createdAt),
    updatedAt: time(raw.updatedAt),
    mergedAt: optionalTime(raw.mergedAt),
    closedAt: optionalTime(raw.closedAt),
    lastReadyForReviewAt: optionalTime(raw.timelineItems.nodes.at(-1)?.createdAt ?? null),
    reviews: compact(raw.reviews.nodes)
      .map(toReview)
      .filter((review): review is Review => review !== null)
      .sort((a, b) => a.submittedAt.toMillis() - b.submittedAt.toMillis()),
  };
}

export function toPRState(state: string): PRState {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

export function toMergeable(mergeable: string): Mergeable {
  if (mergeable === "MERGEABLE") return "mergeable";
  if (mergeable === "CONFLICTING") return "conflicting";
  return "unknown";
}

export function toPendingReviewers(nodes: RawPullRequest["reviewRequests"]["nodes"]): {
  users: string[];
  teams: string[];
} {
  const users: string[] = [];
  const teams: string[] = [];
  for (const node of nodes) {
    const reviewer = node?.requestedReviewer;
    if (!reviewer) continue;
    if (reviewer.__typename === "Team") {
      if (reviewer.slug) teams.push(reviewer.slug);
    } else if (reviewer.login) {
      users.push(normalizeLogin(reviewer));
    }
  }
  return { users, teams };
}

const REVIEW_STATES: Record<string, ReviewState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

function toReview(raw: RawReview): Review | null {
  const state = REVIEW_STATES[raw.state];
  // PENDING reviews are unsubmitted drafts (no submittedAt).
  if (!state || !raw.submittedAt) return null;
  return { author: normalizeLogin(raw.author), state, submittedAt: time(raw.submittedAt) };
}

/**
 * The latest review per reviewer. `latestOpinionatedReviews` keeps an approval or change request
 * even after the reviewer comments again; `latestReviews` adds reviewers who only commented.
 */
export function toLatestReviews(opinionated: (RawReview | null)[], latest: (RawReview | null)[]): Review[] {
  const byAuthor = new Map<string, Review>();
  for (const raw of [...compact(opinionated), ...compact(latest)]) {
    const review = toReview(raw);
    if (review && !byAuthor.has(review.author)) byAuthor.set(review.author, review);
  }
  return [...byAuthor.values()];
}

const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

export function checkRunOutcome(status: string, conclusion: string | null): CheckOutcome {
  if (status !== "COMPLETED") return "pending";
  if (conclusion === "SUCCESS") return "success";
  if (conclusion && FAILING_CONCLUSIONS.has(conclusion)) return "failure";
  return "neutral"; // NEUTRAL, SKIPPED, STALE
}

export function statusOutcome(state: string): CheckOutcome {
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failure";
  return "pending"; // PENDING, EXPECTED
}

/**
 * One check per (source, name): the latest run, since re-runs keep the old ones in the rollup.
 * The rollup's own `state` is unreliable (research: state-model-data §2), so outcomes come from here.
 */
export function toChecks(contexts: (RawCheckContext | null)[]): Check[] {
  const runsByCheck = new Map<string, RawCheckContext[]>();
  for (const context of compact(contexts)) {
    const key = `${context.__typename}:${contextName(context)}`;
    runsByCheck.set(key, [...(runsByCheck.get(key) ?? []), context]);
  }
  return [...runsByCheck.values()].map((runs) => {
    const latest = runs.reduce((newest, run) => (runTime(run) >= runTime(newest) ? run : newest));
    return {
      name: contextName(latest),
      source: latest.__typename === "CheckRun" ? "check_run" : "status",
      outcome:
        latest.__typename === "CheckRun"
          ? checkRunOutcome(latest.status, latest.conclusion)
          : statusOutcome(latest.state),
      required: requiredOf(runs),
    };
  });
}

function contextName(context: RawCheckContext): string {
  return context.__typename === "CheckRun" ? context.name : context.context;
}

/** Required-ness belongs to the check name, so any run saying "required" settles it. */
function requiredOf(runs: RawCheckContext[]): boolean | null {
  if (runs.some((run) => run.isRequired === true)) return true;
  return runs.some((run) => run.isRequired === false) ? false : null;
}

/** A run that hasn't started yet (queued re-run) is the newest. */
function runTime(context: RawCheckContext): number {
  const stamp = context.__typename === "CheckRun" ? (context.completedAt ?? context.startedAt) : context.createdAt;
  return stamp ? time(stamp).toMillis() : Number.POSITIVE_INFINITY;
}

function lastTimelineTimes(nodes: RawPullRequest["timelineItems"]["nodes"]): {
  ReadyForReviewEvent: DateTime | null;
  ConvertToDraftEvent: DateTime | null;
} {
  const result = { ReadyForReviewEvent: null as DateTime | null, ConvertToDraftEvent: null as DateTime | null };
  for (const node of compact(nodes)) {
    if (!node.createdAt) continue;
    if (node.__typename === "ReadyForReviewEvent" || node.__typename === "ConvertToDraftEvent") {
      const at = time(node.createdAt);
      const current = result[node.__typename];
      if (!current || at > current) result[node.__typename] = at;
    }
  }
  return result;
}

function time(iso: string): DateTime {
  const parsed = DateTime.fromISO(iso, { zone: "utc" });
  if (!parsed.isValid) throw new Error(`GitHub returned an invalid timestamp "${iso}"`);
  return parsed;
}

function optionalTime(iso: string | null): DateTime | null {
  return iso ? time(iso) : null;
}

export function compact<T>(items: readonly (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null);
}
