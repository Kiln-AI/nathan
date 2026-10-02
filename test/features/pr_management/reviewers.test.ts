import { describe, expect, it } from "vitest";
import { decodeReviewers, reviewerLines } from "../../../src/features/pr_management/reviewers";
import { type RawReview, toLatestReviews } from "../../../src/github/normalize";
import { aPR, aReview } from "../../builders/github";

const rawReview = (login: string, state: string, at: string): RawReview => ({
  state,
  submittedAt: at,
  author: { __typename: "User", login },
});

describe("reviewerLines", () => {
  it("lists pending people, then teams, then everyone else's latest review", () => {
    const pr = aPR({
      pendingReviewers: ["bob"],
      pendingTeams: ["core"],
      reviews: [
        aReview({ author: "bob", state: "changes_requested" }),
        aReview({ author: "carol", state: "approved" }),
        aReview({ author: "dan", state: "commented" }),
        aReview({ author: "erin", state: "dismissed" }),
        aReview({ author: "alice", state: "commented" }),
      ],
    });
    expect(reviewerLines(pr)).toEqual([
      { login: "bob", status: "pending" },
      { login: "core", status: "pending", team: true },
      { login: "carol", status: "approved" },
      { login: "dan", status: "commented" },
    ]);
  });

  it("leaves out the author as a pending reviewer", () => {
    expect(reviewerLines(aPR({ pendingReviewers: ["alice"] }))).toEqual([]);
  });

  it("shows a reviewer requested again after reviewing as pending", () => {
    const pr = aPR({ pendingReviewers: ["Bob"], reviews: [aReview({ author: "bob", state: "approved" })] });
    expect(reviewerLines(pr)).toEqual([{ login: "Bob", status: "pending" }]);
  });

  it("shows a reviewer who commented after their approval was dismissed as commented", () => {
    const reviews = toLatestReviews(
      [rawReview("bob", "DISMISSED", "2026-10-01T14:00:00Z")],
      [rawReview("bob", "COMMENTED", "2026-10-01T16:00:00Z")],
    );
    expect(reviewerLines(aPR({ reviews }))).toEqual([{ login: "bob", status: "commented" }]);
  });

  it("leaves out a reviewer whose approval was dismissed when they did nothing after", () => {
    const reviews = toLatestReviews([], [rawReview("bob", "DISMISSED", "2026-10-01T14:00:00Z")]);
    expect(reviewerLines(aPR({ reviews }))).toEqual([]);
  });
});

describe("decodeReviewers", () => {
  it("reads the lines it stored", () => {
    const lines = [
      { login: "joe", status: "pending" },
      { login: "core", status: "pending", team: true },
      { login: "bob", status: "approved" },
    ];
    expect(decodeReviewers(JSON.stringify(lines))).toEqual(lines);
  });

  it.each(["not json", "null", '{"login":"bob","status":"approved"}', '"bob"'])("reads %s as no reviewers", (json) => {
    expect(decodeReviewers(json)).toEqual([]);
  });

  it("leaves out lines it can't show, keeping the rest", () => {
    const json = JSON.stringify([
      { login: "bob", status: "dismissed" },
      { status: "approved" },
      { login: "", status: "approved" },
      { login: "carol", status: "approved", team: "yes" },
      null,
      "dan",
      { login: "erin", status: "commented", extra: 1 },
    ]);
    expect(decodeReviewers(json)).toEqual([{ login: "erin", status: "commented" }]);
  });
});
