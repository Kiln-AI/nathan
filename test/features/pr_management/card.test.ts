import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { type CardModel, ownersText, renderCard, reviewerLines } from "../../../src/features/pr_management/card";
import { aPR, aReview } from "../../builders/github";
import { testPeople } from "../../helpers/pr";

const NOW = DateTime.fromISO("2026-10-05T14:00:00Z", { zone: "utc" });
const people = testPeople();

function aCard(overrides: Partial<CardModel> = {}): CardModel {
  return {
    repo: "Kiln-AI/Kiln",
    number: 101,
    title: "Add the thing",
    url: "https://github.com/Kiln-AI/Kiln/pull/101",
    author: "alice",
    additions: 120,
    deletions: 8,
    createdAt: DateTime.fromISO("2026-10-03T10:00:00Z", { zone: "utc" }),
    state: "awaiting_review",
    owners: ["bob"],
    reviewers: [{ login: "bob", status: "pending" }],
    modifiers: [],
    note: null,
    submittedBy: null,
    ...overrides,
  };
}

const render = (overrides: Partial<CardModel> = {}) => renderCard(aCard(overrides), people, NOW);
const golden = (name: string, overrides: Partial<CardModel>) =>
  expect(`${JSON.stringify(render(overrides), null, 2)}\n`).toMatchFileSnapshot(`__snapshots__/card_${name}.json`);

describe("renderCard golden files", () => {
  it("team PR awaiting review", async () => {
    await golden("awaiting_review", {});
  });

  it("OSS PR with modifiers, a note and a submitter", async () => {
    await golden("oss_with_request", {
      author: "outsider",
      state: "approved",
      owners: ["dan"],
      reviewers: [
        { login: "bob", status: "approved" },
        { login: "carol", status: "changes_requested" },
        { login: "core", status: "pending", team: true },
      ],
      modifiers: ["quick", "urgent"],
      note: "Please look at the migration first.\nThe rest is mechanical.",
      submittedBy: "UCAROL",
    });
  });

  it("in the merge queue", async () => {
    await golden("in_merge_queue", {
      state: "in_merge_queue",
      owners: [],
      reviewers: [{ login: "bob", status: "approved" }],
    });
  });

  it("merged", async () => {
    await golden("merged", { state: "merged", owners: [], reviewers: [{ login: "bob", status: "approved" }] });
  });

  it("closed", async () => {
    await golden("closed", { state: "closed", owners: [], reviewers: [] });
  });
});

describe("renderCard", () => {
  it("credits the author when nobody submitted the form", () => {
    expect(JSON.stringify(render().blocks.at(-1))).toContain("Requested by <@UALICE>");
    expect(JSON.stringify(render({ submittedBy: "UCAROL" }).blocks.at(-1))).toContain("Requested by <@UCAROL>");
  });

  it("names unmapped people by login and pluralises owners", () => {
    const card = JSON.stringify(render({ author: "stranger", owners: ["bob", "outsider"], reviewers: [] }));
    expect(card).toContain("by stranger");
    expect(card).toContain("Owners: <@UBOB>, outsider");
  });

  it("names no owner when nobody owns the PR", () => {
    expect(ownersText(["<@UBOB>"])).toBe("Owner: <@UBOB>");
    expect(ownersText(["<@UBOB>", "outsider"])).toBe("Owners: <@UBOB>, outsider");
    expect(ownersText([])).toBeNull();
  });

  it("escapes the title and leaves out empty sections", () => {
    const card = render({ title: "Fix <script> & stuff", reviewers: [], note: null });
    expect(card.text).toBe("Kiln-AI/Kiln#101 Fix &lt;script&gt; &amp; stuff: Awaiting review");
    expect(card.blocks).toHaveLength(4);
  });
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
});
