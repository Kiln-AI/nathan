import { normalizeGithubLogin } from "../../core/directory";
import type { Check, Mergeable, PRData } from "../../github";

// The core model (spec §4.2): one state, next step and owner set per PR, computed only from
// GitHub data. Everything else (card, handoffs, reminders, report) reads this.

export type PRStatusState =
  | "merged"
  | "closed"
  | "draft"
  | "wip_title"
  | "conflict"
  | "ci_failing"
  | "awaiting_review"
  | "changes_requested"
  | "approved"
  | "needs_rerequest"
  | "needs_reviewer";

export type PRCategory = "team" | "dependabot" | "oss";

export interface PRStatus {
  state: PRStatusState;
  /** GitHub logins, sorted and unique. Empty for merged and closed PRs. */
  owners: string[];
}

export interface StateInfo {
  emoji: string;
  label: string;
  /** null once the PR is merged or closed. */
  nextStep: string | null;
}

export const STATE_INFO: Record<PRStatusState, StateInfo> = {
  merged: { emoji: "🟣", label: "Merged", nextStep: null },
  closed: { emoji: "⚫", label: "Closed", nextStep: null },
  draft: { emoji: "📝", label: "Draft", nextStep: "Finish & mark ready" },
  wip_title: { emoji: "🚧", label: "Work in progress", nextStep: 'Convert to draft, or drop "WIP" from the title' },
  conflict: { emoji: "⚠️", label: "Merge conflict", nextStep: "Resolve conflicts" },
  ci_failing: { emoji: "❌", label: "CI failing", nextStep: "Fix CI" },
  awaiting_review: { emoji: "👀", label: "Awaiting review", nextStep: "Review" },
  changes_requested: { emoji: "🔁", label: "Changes requested", nextStep: "Address feedback & re-request review" },
  approved: { emoji: "✅", label: "Approved", nextStep: "Merge" },
  needs_rerequest: { emoji: "💬", label: "Reviewed", nextStep: "Re-request review or merge" },
  needs_reviewer: { emoji: "🙋", label: "Needs a reviewer", nextStep: "Request a reviewer" },
};

export function isFinal(state: PRStatusState): boolean {
  return state === "merged" || state === "closed";
}

export function sameOwners(a: readonly string[], b: readonly string[]): boolean {
  const left = normalizedOwners(a.map((login) => login.toLowerCase()));
  const right = normalizedOwners(b.map((login) => login.toLowerCase()));
  return left.length === right.length && left.every((login, i) => login === right[i]);
}

export function categorize(
  author: string,
  deps: { isTeamMember(login: string): boolean; botAuthors: readonly string[] },
): PRCategory {
  const login = normalizeGithubLogin(author);
  if (deps.botAuthors.some((bot) => normalizeGithubLogin(bot) === login)) return "dependabot";
  return deps.isTeamMember(author) ? "team" : "oss";
}

export function isWipTitle(title: string, pattern: string): boolean {
  return new RegExp(pattern, "i").test(title);
}

/** GitHub computes mergeability lazily: "unknown" means "not computed yet", so keep the last known value. */
export function effectiveMergeable(current: Mergeable, lastKnown: Mergeable | undefined): Mergeable {
  return current === "unknown" ? (lastKnown ?? "unknown") : current;
}

/** Required checks failing; when no check is required, any failing check counts. Running checks never fail. */
export function isCiFailing(checks: readonly Check[]): boolean {
  const failing = checks.filter((check) => check.outcome === "failure");
  if (failing.length === 0) return false;
  const anyRequired = checks.some((check) => check.required === true);
  return anyRequired ? failing.some((check) => check.required === true) : true;
}

export interface StatusContext {
  category: PRCategory;
  triager: string;
  wipTitlePattern: string;
  /** The stored mergeability, used while GitHub reports "unknown". */
  lastKnownMergeable?: Mergeable;
}

/** Spec §4.2 rules in order; the first match wins. The merge queue rule arrives in phase 9. */
export function computeStatus(pr: PRData, ctx: StatusContext): PRStatus {
  const authorSide = (state: PRStatusState): PRStatus => ({
    state,
    owners: [ctx.category === "team" ? pr.author : ctx.triager],
  });
  const isAuthor = (login: string) => normalizeGithubLogin(login) === normalizeGithubLogin(pr.author);
  // "Nathan does not alter the state for a reviewer who is also the author": the author's own
  // reviews (GitHub records one whenever the author replies to a review comment) don't count.
  const reviews = pr.reviews.filter((review) => !isAuthor(review.author));
  const pendingReviewers = pr.pendingReviewers.filter((login) => !isAuthor(login));

  if (pr.state === "merged") return { state: "merged", owners: [] };
  if (pr.state === "closed") return { state: "closed", owners: [] };
  if (pr.isDraft) return authorSide("draft");
  if (isWipTitle(pr.title, ctx.wipTitlePattern)) return authorSide("wip_title");
  if (effectiveMergeable(pr.mergeable, ctx.lastKnownMergeable) === "conflicting") return authorSide("conflict");
  if (isCiFailing(pr.checks)) return authorSide("ci_failing");
  // Team review requests aren't expanded (spec §4.2): a team alone is no pending reviewer.
  if (pendingReviewers.length > 0) return { state: "awaiting_review", owners: normalizedOwners(pendingReviewers) };
  if (reviews.some((review) => review.state === "changes_requested")) return authorSide("changes_requested");
  if (reviews.some((review) => review.state === "approved")) return authorSide("approved");
  if (reviews.length > 0) return authorSide("needs_rerequest");
  return authorSide("needs_reviewer");
}

/** Sorted and deduped case-insensitively, keeping the first spelling seen. */
function normalizedOwners(logins: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const login of logins) {
    const key = login.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, login);
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, login]) => login);
}
