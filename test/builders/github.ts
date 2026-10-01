import { DateTime } from "luxon";
import type { Check, PRData, PRHistory, Review } from "../../src/github";

const at = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });

/** An open, non-draft team PR with no reviewers, reviews or checks. */
export function aPR(overrides: Partial<PRData> = {}): PRData {
  const repo = overrides.repo ?? "Kiln-AI/Kiln";
  const number = overrides.number ?? 101;
  return {
    repo,
    number,
    nodeId: `PR_${repo}_${number}`,
    title: "Add the thing",
    url: `https://github.com/${repo}/pull/${number}`,
    author: "alice",
    authorIsBot: false,
    state: "open",
    isDraft: false,
    isInMergeQueue: false,
    createdAt: at("2026-10-01T15:00:00Z"),
    updatedAt: at("2026-10-01T15:00:00Z"),
    mergedAt: null,
    closedAt: null,
    lastReadyForReviewAt: null,
    lastConvertedToDraftAt: null,
    additions: 10,
    deletions: 2,
    baseRef: "main",
    headSha: `sha-${number}`,
    mergeable: "mergeable",
    pendingReviewers: [],
    pendingTeams: [],
    reviews: [],
    checks: [],
    checksTruncated: false,
    ...overrides,
  };
}

export function aReview(overrides: Partial<Review> = {}): Review {
  return { author: "bob", state: "approved", submittedAt: at("2026-10-02T15:00:00Z"), ...overrides };
}

export function aCheck(overrides: Partial<Check> = {}): Check {
  return { name: "test", source: "check_run", outcome: "success", required: null, ...overrides };
}

export function aPRHistory(overrides: Partial<PRHistory> = {}): PRHistory {
  const repo = overrides.repo ?? "Kiln-AI/Kiln";
  const number = overrides.number ?? 101;
  return {
    repo,
    number,
    title: "Add the thing",
    url: `https://github.com/${repo}/pull/${number}`,
    author: "alice",
    authorIsBot: false,
    state: "merged",
    isDraft: false,
    createdAt: at("2026-10-01T15:00:00Z"),
    updatedAt: at("2026-10-02T15:00:00Z"),
    mergedAt: at("2026-10-02T15:00:00Z"),
    closedAt: at("2026-10-02T15:00:00Z"),
    lastReadyForReviewAt: null,
    reviews: [],
    ...overrides,
  };
}
