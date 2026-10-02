import { z } from "zod";
import { normalizeGithubLogin } from "../../core/directory";
import type { PRData } from "../../github";

// Every reviewer of a PR with their status, as the card and "Your Open PRs" show them (spec §4.4, §4.9).
// `pr_prs.reviewers` stores these lines as JSON, so this shape is also a storage format.

export const REVIEWER_STATUSES = ["pending", "approved", "changes_requested", "commented"] as const;

export type ReviewerStatus = (typeof REVIEWER_STATUSES)[number];

export interface ReviewerLine {
  /** A GitHub login, or a team slug when `team` is set. */
  login: string;
  status: ReviewerStatus;
  team?: boolean;
}

/** Pending reviewers (people, then teams), then everyone else's latest review. Dismissed reviews and the author's own are left out. */
export function reviewerLines(pr: PRData): ReviewerLine[] {
  const isAuthor = (login: string) => normalizeGithubLogin(login) === normalizeGithubLogin(pr.author);
  const pending = new Set(pr.pendingReviewers.map(normalizeGithubLogin));
  const lines: ReviewerLine[] = [
    ...pr.pendingReviewers.filter((login) => !isAuthor(login)).map((login) => pendingLine(login)),
    ...pr.pendingTeams.map((slug) => pendingLine(slug, true)),
  ];
  for (const review of pr.reviews) {
    if (review.state === "dismissed" || isAuthor(review.author) || pending.has(normalizeGithubLogin(review.author))) {
      continue;
    }
    lines.push({ login: review.author, status: review.state });
  }
  return lines;
}

function pendingLine(login: string, team = false): ReviewerLine {
  return team ? { login, status: "pending", team } : { login, status: "pending" };
}

const storedLine: z.ZodType<ReviewerLine> = z.object({
  login: z.string().min(1),
  status: z.enum(REVIEWER_STATUSES),
  team: z.boolean().optional(),
});

/**
 * The stored lines, leniently: a value that isn't a JSON array reads as no reviewers, and lines this
 * version can't show (an unknown status, no login) are left out, so one bad row can't break a list.
 */
export function decodeReviewers(json: string): ReviewerLine[] {
  const lines = z.array(z.unknown()).safeParse(parseJson(json));
  if (!lines.success) return [];
  return lines.data.flatMap((line) => {
    const decoded = storedLine.safeParse(line);
    return decoded.success ? [decoded.data] : [];
  });
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
