import { describe, expect, it } from "vitest";
import { DEFAULT_WIP_TITLE_PATTERN } from "../../../src/features/pr_management/config";
import {
  categorize,
  computeStatus,
  effectiveMergeable,
  isCiFailing,
  isFinal,
  isWipTitle,
  type PRCategory,
  STATE_INFO,
  type StatusContext,
  sameOwners,
} from "../../../src/features/pr_management/status";
import type { PRData } from "../../../src/github";
import { aCheck, aPR, aReview } from "../../builders/github";

const team: StatusContext = { category: "team", triager: "dan", wipTitlePattern: DEFAULT_WIP_TITLE_PATTERN };
const status = (overrides: Partial<PRData>, ctx: Partial<StatusContext> = {}) =>
  computeStatus(aPR(overrides), { ...team, ...ctx });

const failing = aCheck({ outcome: "failure", required: false });

describe("computeStatus rules", () => {
  it.each<[string, Partial<PRData>, string, string[]]>([
    ["1 merged", { state: "merged" }, "merged", []],
    ["2 closed", { state: "closed" }, "closed", []],
    ["3 merge queue", { isInMergeQueue: true }, "in_merge_queue", []],
    ["4 draft", { isDraft: true }, "draft", ["alice"]],
    ["5 WIP title", { title: "WIP: half done" }, "wip_title", ["alice"]],
    ["6 conflict", { mergeable: "conflicting" }, "conflict", ["alice"]],
    ["7 CI failing", { checks: [failing] }, "ci_failing", ["alice"]],
    ["8 pending reviewer", { pendingReviewers: ["carol", "bob"] }, "awaiting_review", ["bob", "carol"]],
    [
      "9 changes requested",
      { reviews: [aReview({ author: "bob", state: "changes_requested" })] },
      "changes_requested",
      ["alice"],
    ],
    ["10 approved", { reviews: [aReview({ state: "approved" })] }, "approved", ["alice"]],
    ["11 reviewed", { reviews: [aReview({ state: "commented" })] }, "needs_rerequest", ["alice"]],
    ["12 no reviewers", {}, "needs_reviewer", ["alice"]],
  ])("rule %s", (_name, overrides, state, owners) => {
    expect(status(overrides)).toEqual({ state, owners });
  });

  it.each<[string, Partial<PRData>, Partial<PRData>, string]>([
    ["merged beats draft", { state: "merged" }, { isDraft: true }, "merged"],
    ["closed beats draft", { state: "closed" }, { isDraft: true }, "closed"],
    ["merged beats merge queue", { state: "merged" }, { isInMergeQueue: true }, "merged"],
    ["closed beats merge queue", { state: "closed" }, { isInMergeQueue: true }, "closed"],
    ["merge queue beats draft", { isInMergeQueue: true }, { isDraft: true }, "in_merge_queue"],
    ["merge queue beats WIP", { isInMergeQueue: true }, { title: "WIP: x" }, "in_merge_queue"],
    ["merge queue beats conflict", { isInMergeQueue: true }, { mergeable: "conflicting" }, "in_merge_queue"],
    ["merge queue beats CI", { isInMergeQueue: true }, { checks: [failing] }, "in_merge_queue"],
    ["merge queue beats pending reviewer", { isInMergeQueue: true }, { pendingReviewers: ["bob"] }, "in_merge_queue"],
    ["draft beats WIP", { isDraft: true }, { title: "[WIP] x" }, "draft"],
    ["WIP beats conflict", { title: "[WIP] x" }, { mergeable: "conflicting" }, "wip_title"],
    ["conflict beats CI", { mergeable: "conflicting" }, { checks: [failing] }, "conflict"],
    ["CI beats pending reviewer", { checks: [failing] }, { pendingReviewers: ["bob"] }, "ci_failing"],
    [
      "pending reviewer beats changes requested",
      { pendingReviewers: ["bob"] },
      { reviews: [aReview({ author: "carol", state: "changes_requested" })] },
      "awaiting_review",
    ],
    [
      "changes requested beats approval",
      {
        reviews: [
          aReview({ author: "bob", state: "approved" }),
          aReview({ author: "carol", state: "changes_requested" }),
        ],
      },
      {},
      "changes_requested",
    ],
    [
      "approval beats comments",
      { reviews: [aReview({ author: "bob", state: "commented" }), aReview({ author: "carol", state: "approved" })] },
      {},
      "approved",
    ],
  ])("%s", (_name, winner, loser, state) => {
    expect(status({ ...loser, ...winner }).state).toBe(state);
  });
});

describe("computeStatus owners", () => {
  it.each<[PRCategory]>([["dependabot"], ["oss"]])("gives a %s PR's author-side steps to the triager", (category) => {
    expect(status({ author: "outsider" }, { category })).toEqual({ state: "needs_reviewer", owners: ["dan"] });
    expect(status({ author: "outsider", isDraft: true }, { category }).owners).toEqual(["dan"]);
  });

  it("gives a non-team PR in a merge queue no owner, not even the triager", () => {
    expect(status({ author: "outsider", isInMergeQueue: true }, { category: "oss" })).toEqual({
      state: "in_merge_queue",
      owners: [],
    });
  });

  it("keeps reviewer-owned steps with the reviewers on non-team PRs", () => {
    expect(status({ author: "outsider", pendingReviewers: ["bob"] }, { category: "oss" })).toEqual({
      state: "awaiting_review",
      owners: ["bob"],
    });
  });

  it("sorts and dedupes pending reviewers case-insensitively", () => {
    expect(status({ pendingReviewers: ["Carol", "bob", "carol"] }).owners).toEqual(["bob", "Carol"]);
  });

  it("counts bot reviewers but not team requests", () => {
    expect(status({ pendingReviewers: ["copilot[bot]"] }).owners).toEqual(["copilot[bot]"]);
    expect(status({ pendingTeams: ["core"] }).state).toBe("needs_reviewer");
    expect(status({ pendingTeams: ["core"], reviews: [aReview({ state: "commented" })] }).state).toBe(
      "needs_rerequest",
    );
  });

  it("ignores the author's own reviews and review requests", () => {
    const own = aReview({ author: "Alice", state: "commented" });
    expect(status({ reviews: [own] }).state).toBe("needs_reviewer");
    expect(status({ pendingReviewers: ["alice"] }).state).toBe("needs_reviewer");
  });

  it("counts a dismissed review only as 'has reviews'", () => {
    expect(status({ reviews: [aReview({ state: "dismissed" })] }).state).toBe("needs_rerequest");
  });
});

describe("CI failing", () => {
  it("counts a failing required check", () => {
    expect(
      isCiFailing([aCheck({ outcome: "failure", required: true }), aCheck({ name: "lint", required: false })]),
    ).toBe(true);
  });

  it("ignores a failing optional check when some check is required", () => {
    expect(
      isCiFailing([aCheck({ outcome: "failure", required: false }), aCheck({ name: "req", required: true })]),
    ).toBe(false);
  });

  it("counts any failure when nothing is required (including unresolved required-ness)", () => {
    expect(isCiFailing([aCheck({ outcome: "failure", required: false })])).toBe(true);
    expect(isCiFailing([aCheck({ outcome: "failure", required: null })])).toBe(true);
  });

  it("never counts pending, neutral or passing checks", () => {
    expect(isCiFailing([])).toBe(false);
    expect(
      isCiFailing([
        aCheck({ outcome: "pending", required: true }),
        aCheck({ outcome: "neutral" }),
        aCheck({ outcome: "success" }),
      ]),
    ).toBe(false);
  });
});

describe("mergeability", () => {
  it("keeps the last known value while GitHub reports unknown", () => {
    expect(effectiveMergeable("unknown", "conflicting")).toBe("conflicting");
    expect(effectiveMergeable("unknown", undefined)).toBe("unknown");
    expect(effectiveMergeable("mergeable", "conflicting")).toBe("mergeable");
    expect(status({ mergeable: "unknown" }, { lastKnownMergeable: "conflicting" }).state).toBe("conflict");
    expect(status({ mergeable: "unknown" }).state).toBe("needs_reviewer");
  });
});

describe("isWipTitle", () => {
  it.each(["WIP: half done", "[WIP] half done", "(wip) half done", "wip half done", "  Wip:x", "WIP"])(
    "matches %j",
    (title) => {
      expect(isWipTitle(title, DEFAULT_WIP_TITLE_PATTERN)).toBe(true);
    },
  );

  it.each(["Wipe the cache", "Fix WIP handling", "Swipe left", "Add wipers"])("doesn't match %j", (title) => {
    expect(isWipTitle(title, DEFAULT_WIP_TITLE_PATTERN)).toBe(false);
  });

  it("uses a custom pattern", () => {
    expect(isWipTitle("DO NOT MERGE: x", "^do not merge")).toBe(true);
    expect(status({ title: "DNM x" }, { wipTitlePattern: "^dnm\\b" }).state).toBe("wip_title");
  });
});

describe("categorize", () => {
  const deps = { isTeamMember: (login: string) => login === "alice", botAuthors: ["dependabot[bot]", "Renovate"] };

  it("matches bot authors case-insensitively, with or without [bot]", () => {
    expect(categorize("dependabot[bot]", deps)).toBe("dependabot");
    expect(categorize("Dependabot", deps)).toBe("dependabot");
    expect(categorize("renovate[bot]", deps)).toBe("dependabot");
  });

  it("tells team members from outside contributors", () => {
    expect(categorize("alice", deps)).toBe("team");
    expect(categorize("stranger", deps)).toBe("oss");
  });
});

describe("helpers", () => {
  it("isFinal is true only for merged and closed", () => {
    expect(Object.keys(STATE_INFO).filter((state) => isFinal(state as keyof typeof STATE_INFO))).toEqual([
      "merged",
      "closed",
    ]);
  });

  it("sameOwners ignores order and case", () => {
    expect(sameOwners(["Bob", "carol"], ["carol", "bob"])).toBe(true);
    expect(sameOwners(["bob"], ["bob", "carol"])).toBe(false);
    expect(sameOwners(["bob"], ["carol"])).toBe(false);
  });

  it("final states have no next step", () => {
    expect(STATE_INFO.merged.nextStep).toBeNull();
    expect(STATE_INFO.closed.nextStep).toBeNull();
  });

  it("a PR in a merge queue isn't final, and waits for the queue", () => {
    expect(isFinal("in_merge_queue")).toBe(false);
    expect(STATE_INFO.in_merge_queue.nextStep).toBe("Wait for merge queue");
  });
});
