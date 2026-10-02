import { describe, expect, it } from "vitest";
import {
  checkRunOutcome,
  normalizeLogin,
  type RawCheckContext,
  type RawPullRequest,
  type RawReview,
  statusOutcome,
  toChecks,
  toLatestReviews,
  toMergeable,
  toPendingReviewers,
  toPRData,
  toPRState,
} from "../../src/github/normalize";
import sweepPage1 from "../fixtures/github/sweep_page1.json?raw";
import { fixture } from "../helpers/github";

const run = (name: string, status: string, conclusion: string | null, at: string | null, isRequired?: boolean) =>
  ({
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    startedAt: at,
    completedAt: status === "COMPLETED" ? at : null,
    ...(isRequired === undefined ? {} : { isRequired }),
  }) as RawCheckContext;

const review = (login: string, state: string, at: string | null, typename = "User"): RawReview => ({
  state,
  submittedAt: at,
  author: { __typename: typename, login },
});

describe("normalizeLogin", () => {
  it("keeps users, suffixes bots like REST does, and names deleted accounts ghost", () => {
    expect(normalizeLogin({ __typename: "User", login: "alice" })).toBe("alice");
    expect(normalizeLogin({ __typename: "Bot", login: "dependabot" })).toBe("dependabot[bot]");
    expect(normalizeLogin({ __typename: "Bot", login: "dependabot[bot]" })).toBe("dependabot[bot]");
    expect(normalizeLogin(null)).toBe("ghost");
  });
});

describe("check outcomes", () => {
  it.each([
    ["QUEUED", null, "pending"],
    ["IN_PROGRESS", null, "pending"],
    ["WAITING", null, "pending"],
    ["COMPLETED", "SUCCESS", "success"],
    ["COMPLETED", "FAILURE", "failure"],
    ["COMPLETED", "TIMED_OUT", "failure"],
    ["COMPLETED", "CANCELLED", "failure"],
    ["COMPLETED", "STARTUP_FAILURE", "failure"],
    ["COMPLETED", "ACTION_REQUIRED", "failure"],
    ["COMPLETED", "NEUTRAL", "neutral"],
    ["COMPLETED", "SKIPPED", "neutral"],
    ["COMPLETED", "STALE", "neutral"],
    ["COMPLETED", null, "neutral"],
  ])("check run %s/%s is %s", (status, conclusion, outcome) => {
    expect(checkRunOutcome(status, conclusion)).toBe(outcome);
  });

  it.each([
    ["SUCCESS", "success"],
    ["FAILURE", "failure"],
    ["ERROR", "failure"],
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
  ])("status %s is %s", (state, outcome) => {
    expect(statusOutcome(state)).toBe(outcome);
  });
});

describe("toChecks", () => {
  it("keeps the latest run per check name, so a passing re-run clears a failure", () => {
    const checks = toChecks([
      run("test", "COMPLETED", "FAILURE", "2026-10-01T10:00:00Z"),
      run("test", "COMPLETED", "SUCCESS", "2026-10-01T11:00:00Z"),
      run("lint", "COMPLETED", "SUCCESS", "2026-10-01T11:00:00Z"),
      run("lint", "COMPLETED", "FAILURE", "2026-10-01T10:00:00Z"),
    ]);
    expect(checks).toEqual([
      { name: "test", source: "check_run", outcome: "success", required: null },
      { name: "lint", source: "check_run", outcome: "success", required: null },
    ]);
  });

  it("treats a queued re-run (no timestamps yet) as the latest", () => {
    const checks = toChecks([
      run("test", "COMPLETED", "FAILURE", "2026-10-01T10:00:00Z"),
      run("test", "QUEUED", null, null),
    ]);
    expect(checks).toEqual([{ name: "test", source: "check_run", outcome: "pending", required: null }]);
  });

  it("keeps a check run and a status with the same name apart", () => {
    const checks = toChecks([
      run("ci", "COMPLETED", "SUCCESS", "2026-10-01T10:00:00Z"),
      { __typename: "StatusContext", context: "ci", state: "FAILURE", createdAt: "2026-10-01T09:00:00Z" },
      null,
    ]);
    expect(checks.map((c) => [c.source, c.outcome])).toEqual([
      ["check_run", "success"],
      ["status", "failure"],
    ]);
  });

  it("dedupes statuses by context, latest first", () => {
    const checks = toChecks([
      { __typename: "StatusContext", context: "ci", state: "FAILURE", createdAt: "2026-10-01T09:00:00Z" },
      { __typename: "StatusContext", context: "ci", state: "SUCCESS", createdAt: "2026-10-01T10:00:00Z" },
    ]);
    expect(checks).toEqual([{ name: "ci", source: "status", outcome: "success", required: null }]);
  });

  it("marks a check required when any of its runs is, and not required when resolved otherwise", () => {
    const checks = toChecks([
      run("test", "COMPLETED", "FAILURE", "2026-10-01T10:00:00Z", true),
      run("test", "COMPLETED", "SUCCESS", "2026-10-01T11:00:00Z", false),
      run("lint", "COMPLETED", "FAILURE", "2026-10-01T10:00:00Z", false),
    ]);
    expect(checks.map((c) => [c.name, c.required])).toEqual([
      ["test", true],
      ["lint", false],
    ]);
  });
});

describe("toLatestReviews", () => {
  it("keeps an approval or change request over a later comment, and adds comment-only reviewers", () => {
    const reviews = toLatestReviews(
      [review("carol", "CHANGES_REQUESTED", "2026-10-01T14:00:00Z"), null],
      [review("carol", "COMMENTED", "2026-10-01T16:00:00Z"), review("dave", "COMMENTED", "2026-10-01T15:00:00Z")],
    );
    expect(reviews.map((r) => [r.author, r.state, r.submittedAt.toISO()])).toEqual([
      ["carol", "changes_requested", "2026-10-01T14:00:00.000Z"],
      ["dave", "commented", "2026-10-01T15:00:00.000Z"],
    ]);
  });

  it("takes the comment a reviewer left after their approval was dismissed", () => {
    // As GitHub returns it: the dismissed approval is in neither list once the reviewer comments.
    const reviews = toLatestReviews([], [review("bob", "COMMENTED", "2026-10-01T16:00:00Z")]);
    expect(reviews.map((r) => [r.author, r.state])).toEqual([["bob", "commented"]]);
  });

  it("doesn't let a dismissed review in the opinionated list hide a later review", () => {
    const reviews = toLatestReviews(
      [review("bob", "DISMISSED", "2026-10-01T14:00:00Z"), review("carol", "APPROVED", "2026-10-01T14:00:00Z")],
      [review("bob", "COMMENTED", "2026-10-01T16:00:00Z"), review("carol", "APPROVED", "2026-10-01T14:00:00Z")],
    );
    expect(reviews.map((r) => [r.author, r.state])).toEqual([
      ["carol", "approved"],
      ["bob", "commented"],
    ]);
  });

  it("keeps a dismissed review when the reviewer did nothing after it", () => {
    // As GitHub returns it: only `latestReviews` has the dismissed review.
    const reviews = toLatestReviews([], [review("bob", "DISMISSED", "2026-10-01T14:00:00Z")]);
    expect(reviews.map((r) => [r.author, r.state])).toEqual([["bob", "dismissed"]]);
  });

  it("keeps dismissed reviews and drops unsubmitted and unknown ones", () => {
    const reviews = toLatestReviews(
      [review("erin", "DISMISSED", "2026-10-01T14:00:00Z")],
      [review("frank", "PENDING", null), review("gina", "SOMETHING_NEW", "2026-10-01T14:00:00Z")],
    );
    expect(reviews.map((r) => [r.author, r.state])).toEqual([["erin", "dismissed"]]);
  });

  it("names bot reviewers like REST does", () => {
    const reviews = toLatestReviews(
      [],
      [review("copilot-pull-request-reviewer", "COMMENTED", "2026-10-01T14:00:00Z", "Bot")],
    );
    expect(reviews[0]?.author).toBe("copilot-pull-request-reviewer[bot]");
  });
});

describe("toPendingReviewers", () => {
  it("separates people and bots from teams, skipping empty entries", () => {
    expect(
      toPendingReviewers([
        { requestedReviewer: { __typename: "User", login: "bob" } },
        { requestedReviewer: { __typename: "Team", slug: "core-team" } },
        { requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } },
        { requestedReviewer: { __typename: "Mannequin", login: "old-user" } },
        { requestedReviewer: { __typename: "EnterpriseTeam" } },
        { requestedReviewer: null },
        null,
      ]),
    ).toEqual({ users: ["bob", "copilot-pull-request-reviewer[bot]", "old-user"], teams: ["core-team"] });
  });
});

describe("state mappings", () => {
  it("maps PR state and mergeability", () => {
    expect([toPRState("OPEN"), toPRState("MERGED"), toPRState("CLOSED")]).toEqual(["open", "merged", "closed"]);
    expect([toMergeable("MERGEABLE"), toMergeable("CONFLICTING"), toMergeable("UNKNOWN")]).toEqual([
      "mergeable",
      "conflicting",
      "unknown",
    ]);
  });
});

describe("toPRData", () => {
  const page = fixture(sweepPage1) as { data: Record<string, { pullRequests: { nodes: RawPullRequest[] } }> };
  const [teamPR, dependabotPR] = page.data.r0?.pullRequests.nodes ?? [];
  const draftPR = page.data.r1?.pullRequests.nodes[0];

  it("normalizes a team PR with reviews, requests, re-runs and timeline events", () => {
    const pr = toPRData("Kiln-AI/Kiln", teamPR as RawPullRequest);
    expect({
      ...pr,
      createdAt: pr.createdAt.toISO(),
      updatedAt: pr.updatedAt.toISO(),
      lastReadyForReviewAt: pr.lastReadyForReviewAt?.toISO(),
      lastConvertedToDraftAt: pr.lastConvertedToDraftAt?.toISO(),
      reviews: pr.reviews.map((r) => ({ ...r, submittedAt: r.submittedAt.toISO() })),
    }).toEqual({
      repo: "Kiln-AI/Kiln",
      number: 101,
      nodeId: "PR_kw101",
      title: "Speed up the eval runner",
      url: "https://github.com/Kiln-AI/Kiln/pull/101",
      author: "alice",
      authorIsBot: false,
      state: "open",
      isDraft: false,
      isInMergeQueue: false,
      createdAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-02T09:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      lastReadyForReviewAt: "2026-10-01T12:00:00.000Z",
      lastConvertedToDraftAt: "2026-10-01T10:00:00.000Z",
      additions: 10,
      deletions: 2,
      baseRef: "main",
      headSha: "0000000000000000000000000000000000000065",
      mergeable: "mergeable",
      pendingReviewers: ["bob", "copilot-pull-request-reviewer[bot]"],
      pendingTeams: ["core-team"],
      reviews: [
        { author: "carol", state: "changes_requested", submittedAt: "2026-10-01T14:00:00.000Z" },
        { author: "dave", state: "commented", submittedAt: "2026-10-01T15:00:00.000Z" },
      ],
      checks: [
        { name: "test", source: "check_run", outcome: "success", required: null },
        { name: "lint", source: "check_run", outcome: "failure", required: null },
        { name: "ci/circleci", source: "status", outcome: "success", required: null },
      ],
      checksTruncated: false,
    });
  });

  it("normalizes a Dependabot PR with a conflict and no checks", () => {
    const pr = toPRData("Kiln-AI/Kiln", dependabotPR as RawPullRequest);
    expect(pr).toMatchObject({
      author: "dependabot[bot]",
      authorIsBot: true,
      mergeable: "conflicting",
      checks: [],
      checksTruncated: false,
      reviews: [],
      pendingReviewers: [],
      lastReadyForReviewAt: null,
    });
  });

  it("normalizes a draft with a running check and unknown mergeability", () => {
    const pr = toPRData("Kiln-AI/nathan", draftPR as RawPullRequest);
    expect(pr).toMatchObject({ isDraft: true, mergeable: "unknown", checks: [{ name: "build", outcome: "pending" }] });
    expect(pr.lastConvertedToDraftAt?.toISO()).toBe("2026-10-01T09:30:00.000Z");
  });

  it("flags truncated check lists and rejects malformed timestamps", () => {
    const truncated = structuredClone(teamPR as RawPullRequest);
    const rollup = truncated.commits.nodes[0]?.commit.statusCheckRollup;
    if (rollup) rollup.contexts.pageInfo.hasNextPage = true;
    expect(toPRData("Kiln-AI/Kiln", truncated).checksTruncated).toBe(true);
    expect(() => toPRData("Kiln-AI/Kiln", { ...truncated, createdAt: "yesterday" })).toThrow(
      'GitHub returned an invalid timestamp "yesterday"',
    );
  });
});
