import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  firstReviewAt,
  mean,
  median,
  peopleStats,
  reviewClockStart,
  trendStats,
} from "../../../src/features/pr_management/metrics";
import { aPRHistory, aReview } from "../../builders/github";
import { aRecord } from "../../builders/pr_record";

const at = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });
const END = at("2026-10-19T12:00:00Z");
const WEEK = { start: END.minus({ days: 7 }), end: END };
const LAST_WEEK = { start: END.minus({ days: 14 }), end: END.minus({ days: 7 }) };
const isTeam = (login: string) => ["alice", "bob", "carol"].includes(login.toLowerCase());

describe("median and mean", () => {
  it("are null for no values", () => {
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
  });

  it("take the middle value, or the average of the middle two", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 10])).toBe(3.5);
    expect(mean([1, 2, 6])).toBe(3);
  });
});

describe("reviewClockStart", () => {
  it("is when the PR was opened, or last marked ready for review if later", () => {
    const createdAt = at("2026-10-01T10:00:00Z");
    expect(reviewClockStart({ createdAt, lastReadyForReviewAt: null })).toEqual(createdAt);
    const ready = at("2026-10-03T10:00:00Z");
    expect(reviewClockStart({ createdAt, lastReadyForReviewAt: ready })).toEqual(ready);
    // GitHub can record a ready event at the creation instant.
    expect(reviewClockStart({ createdAt: ready, lastReadyForReviewAt: createdAt })).toEqual(ready);
  });
});

describe("firstReviewAt", () => {
  const pr = (reviews: ReturnType<typeof aReview>[], lastReadyForReviewAt: DateTime | null = null) =>
    aPRHistory({ createdAt: at("2026-10-01T10:00:00Z"), lastReadyForReviewAt, reviews });

  it("is the earliest review by someone else", () => {
    const first = at("2026-10-02T09:00:00Z");
    expect(
      firstReviewAt(
        pr([
          aReview({ author: "carol", submittedAt: at("2026-10-02T12:00:00Z") }),
          aReview({ author: "bob", state: "commented", submittedAt: first }),
        ]),
      ),
    ).toEqual(first);
  });

  it("ignores the author's own reviews, bots, and reviews before the PR was ready", () => {
    const reviews = [
      aReview({ author: "Alice", submittedAt: at("2026-10-01T11:00:00Z") }),
      aReview({ author: "coderabbit[bot]", submittedAt: at("2026-10-01T12:00:00Z") }),
      aReview({ author: "bob", submittedAt: at("2026-10-02T10:00:00Z") }),
      aReview({ author: "carol", submittedAt: at("2026-10-04T10:00:00Z") }),
    ];
    expect(firstReviewAt(pr(reviews))).toEqual(at("2026-10-02T10:00:00Z"));
    expect(firstReviewAt(pr(reviews, at("2026-10-03T10:00:00Z")))).toEqual(at("2026-10-04T10:00:00Z"));
  });

  it("is null without a review that counts", () => {
    expect(firstReviewAt(pr([]))).toBeNull();
    expect(firstReviewAt(pr([aReview({ author: "alice" })]))).toBeNull();
  });
});

describe("trendStats", () => {
  it("buckets first reviews by when they happened, timed from the review clock start", () => {
    const history = [
      // Opened last week, first reviewed this week: this week's, 30h.
      aPRHistory({
        number: 1,
        state: "open",
        createdAt: at("2026-10-12T00:00:00Z"),
        mergedAt: null,
        closedAt: null,
        reviews: [aReview({ submittedAt: at("2026-10-13T06:00:00Z") })],
      }),
      // Marked ready this week after a long draft: 2h.
      aPRHistory({
        number: 2,
        createdAt: at("2026-09-01T00:00:00Z"),
        lastReadyForReviewAt: at("2026-10-14T00:00:00Z"),
        mergedAt: at("2026-10-15T00:00:00Z"),
        reviews: [aReview({ submittedAt: at("2026-10-14T02:00:00Z") })],
      }),
      // First reviewed last week: last week's.
      aPRHistory({
        number: 3,
        createdAt: at("2026-10-06T00:00:00Z"),
        mergedAt: at("2026-10-08T00:00:00Z"),
        reviews: [aReview({ submittedAt: at("2026-10-06T10:00:00Z") })],
      }),
    ];
    expect(trendStats(WEEK, history, [], isTeam).firstReviewHours).toBe(16);
    expect(trendStats(LAST_WEEK, history, [], isTeam).firstReviewHours).toBe(10);
  });

  it("counts merges in the window and times them from the review clock start", () => {
    const history = [
      aPRHistory({ number: 1, createdAt: at("2026-10-13T00:00:00Z"), mergedAt: at("2026-10-14T00:00:00Z") }),
      aPRHistory({
        number: 2,
        createdAt: at("2026-09-01T00:00:00Z"),
        lastReadyForReviewAt: at("2026-10-15T00:00:00Z"),
        mergedAt: at("2026-10-15T12:00:00Z"),
      }),
      aPRHistory({ number: 3, createdAt: at("2026-10-01T00:00:00Z"), mergedAt: at("2026-10-07T00:00:00Z") }),
      aPRHistory({ number: 4, state: "closed", mergedAt: null, closedAt: at("2026-10-14T00:00:00Z") }),
    ];
    expect(trendStats(WEEK, history, [], isTeam)).toMatchObject({ merged: 2, mergeHours: 18 });
    expect(trendStats(LAST_WEEK, history, [], isTeam)).toMatchObject({ merged: 1, mergeHours: 144 });
  });

  it("leaves out PRs by people outside the team", () => {
    const history = [
      aPRHistory({ author: "outsider", createdAt: at("2026-10-13T00:00:00Z"), mergedAt: at("2026-10-14T00:00:00Z") }),
      aPRHistory({
        author: "dependabot[bot]",
        createdAt: at("2026-10-13T00:00:00Z"),
        mergedAt: at("2026-10-14T00:00:00Z"),
      }),
    ];
    const records = [aRecord({ category: "oss", author: "outsider" })];
    expect(trendStats(WEEK, history, records, isTeam)).toEqual({
      firstReviewHours: null,
      mergeHours: null,
      merged: 0,
      openAgeHours: null,
    });
  });

  it("ages the PRs open at the window's end: open now, or closed since", () => {
    const records = [
      aRecord({ number: 1, createdAt: END.minus({ hours: 10 }) }),
      aRecord({ number: 2, createdAt: END.minus({ days: 9 }) }),
      aRecord({ number: 3, createdAt: END.minus({ days: 20 }), state: "draft" }),
      aRecord({ number: 4, createdAt: END.minus({ days: 20 }), category: "oss", author: "outsider" }),
    ];
    const history = [
      // Merged this week: open at last week's end, 3 days old then.
      aPRHistory({ number: 5, createdAt: END.minus({ days: 10 }), mergedAt: END.minus({ days: 2 }), closedAt: null }),
      // Closed last week: not open at either end.
      aPRHistory({
        number: 6,
        state: "closed",
        createdAt: END.minus({ days: 12 }),
        mergedAt: null,
        closedAt: END.minus({ days: 8 }),
      }),
      // Still open (also in the records): counted once.
      aPRHistory({ number: 2, state: "open", createdAt: END.minus({ days: 9 }), mergedAt: null, closedAt: null }),
      // A draft closed this week: never open for review, not counted.
      aPRHistory({
        number: 7,
        state: "closed",
        isDraft: true,
        createdAt: END.minus({ days: 30 }),
        mergedAt: null,
        closedAt: END.minus({ days: 1 }),
      }),
    ];
    // Now: 10h and 9d.
    expect(trendStats(WEEK, history, records, isTeam).openAgeHours).toBe((10 + 9 * 24) / 2);
    // A week ago: #2 (2d) and #5 (3d); #1 didn't exist yet.
    expect(trendStats(LAST_WEEK, history, records, isTeam).openAgeHours).toBe(60);
  });
});

describe("peopleStats", () => {
  const SINCE = END.minus({ days: 7 });

  it("counts open PRs, reviews waiting, merges and PRs reviewed per person", () => {
    const records = [
      aRecord({ number: 1, author: "alice", state: "awaiting_review", owners: ["bob", "carol"] }),
      aRecord({ number: 2, author: "Alice", state: "awaiting_review", owners: ["BOB"] }),
      aRecord({ number: 3, author: "alice", state: "draft", owners: ["alice"] }),
      aRecord({ number: 4, author: "bob", state: "ci_failing", owners: ["bob"] }),
    ];
    const history = [
      aPRHistory({
        number: 10,
        author: "alice",
        mergedAt: SINCE.plus({ days: 1 }),
        reviews: [
          aReview({ author: "bob", state: "commented", submittedAt: SINCE.plus({ hours: 1 }) }),
          aReview({ author: "bob", submittedAt: SINCE.plus({ hours: 2 }) }),
          aReview({ author: "alice", submittedAt: SINCE.plus({ hours: 3 }) }),
        ],
      }),
      aPRHistory({ number: 11, author: "alice", mergedAt: SINCE.minus({ hours: 1 }) }),
      aPRHistory({
        number: 12,
        author: "carol",
        state: "open",
        mergedAt: null,
        closedAt: null,
        reviews: [
          aReview({ author: "bob", submittedAt: SINCE.plus({ hours: 4 }) }),
          aReview({ author: "alice", submittedAt: SINCE.minus({ hours: 4 }) }),
        ],
      }),
    ];
    expect(peopleStats(["alice", "bob", "carol", "dan"], records, history, SINCE)).toEqual([
      { login: "alice", open: 2, reviewsWaiting: 0, merged: 1, reviewed: 0 },
      { login: "bob", open: 1, reviewsWaiting: 2, merged: 0, reviewed: 2 },
      { login: "carol", open: 0, reviewsWaiting: 1, merged: 0, reviewed: 0 },
      { login: "dan", open: 0, reviewsWaiting: 0, merged: 0, reviewed: 0 },
    ]);
  });
});
