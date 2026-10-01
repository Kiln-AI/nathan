import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { describeHandoff } from "../../../src/features/pr_management/handoff";
import type { PRStatus } from "../../../src/features/pr_management/status";
import type { PREvent } from "../../../src/features/pr_management/store";
import type { PRData } from "../../../src/github";
import { aPR, aReview } from "../../builders/github";
import { testPeople } from "../../helpers/pr";

const people = testPeople();
const at = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });

let nextId = 0;
function anEvent(action: string, actor: string | null, subject: string | null = null): PREvent {
  nextId += 1;
  return { id: nextId, event: "pull_request", action, actor, subject, receivedAt: at("2026-10-05T13:59:00Z") };
}

function handoff(before: PRStatus, after: PRStatus, pr: Partial<PRData> = {}, events: PREvent[] = []): string | null {
  return describeHandoff({ before, after, pr: aPR(pr), events, people });
}

const awaitingBob: PRStatus = { state: "awaiting_review", owners: ["bob"] };
const authorOwns = (state: PRStatus["state"]): PRStatus => ({ state, owners: ["alice"] });

describe("describeHandoff: spec §4.5 examples", () => {
  it("approval hands the PR to the author", () => {
    const pr = { reviews: [aReview({ author: "bob", state: "approved" })] };
    expect(handoff(awaitingBob, authorOwns("approved"), pr)).toBe("<@UALICE> — bob approved ✅. Ready to merge.");
  });

  it("changes requested hands the PR to the author", () => {
    const pr = {
      reviews: [
        aReview({ author: "carol", state: "changes_requested", submittedAt: at("2026-10-02T00:00:00Z") }),
        aReview({ author: "bob", state: "changes_requested", submittedAt: at("2026-10-03T00:00:00Z") }),
      ],
    };
    expect(handoff(awaitingBob, authorOwns("changes_requested"), pr)).toBe(
      "<@UALICE> — bob requested changes 🔁. Over to you.",
    );
  });

  it("a re-request hands the PR to a reviewer who reviewed before", () => {
    const pr = { pendingReviewers: ["bob"], reviews: [aReview({ author: "bob", state: "changes_requested" })] };
    const events = [anEvent("review_requested", "alice", "bob")];
    expect(handoff(authorOwns("changes_requested"), awaitingBob, pr, events)).toBe(
      "<@UBOB> — alice re-requested your review 👀.",
    );
  });

  it("failing CI hands the PR to the author", () => {
    expect(handoff(awaitingBob, authorOwns("ci_failing"))).toBe(
      "<@UALICE> — CI is failing on the latest push ❌. Fix CI.",
    );
  });
});

describe("describeHandoff: review requests", () => {
  it("names the latest requester for a first request", () => {
    const events = [anEvent("review_requested", "carol", "bob"), anEvent("review_requested", "alice", "bob")];
    expect(handoff(authorOwns("needs_reviewer"), awaitingBob, {}, events)).toBe(
      "<@UBOB> — alice requested your review 👀.",
    );
  });

  it("names whoever marked the PR ready when there's no request event", () => {
    const events = [anEvent("synchronize", "alice"), anEvent("ready_for_review", "alice")];
    expect(handoff(authorOwns("draft"), awaitingBob, {}, events)).toBe(
      "<@UBOB> — alice marked this ready for review 👀.",
    );
  });

  it("says the review is requested when nobody is known to have asked (e.g. found by the sweep)", () => {
    expect(handoff(authorOwns("needs_reviewer"), awaitingBob)).toBe("<@UBOB> — Your review is requested 👀.");
    const reviewed = { reviews: [aReview({ author: "bob", state: "commented" })] };
    expect(handoff(authorOwns("needs_rerequest"), awaitingBob, reviewed)).toBe(
      "<@UBOB> — Your review is re-requested 👀.",
    );
  });

  it("tags only the reviewers who are new", () => {
    const events = [anEvent("review_requested", "alice", "carol")];
    expect(handoff(awaitingBob, { state: "awaiting_review", owners: ["bob", "carol"] }, {}, events)).toBe(
      "<@UCAROL> — alice requested your review 👀.",
    );
  });

  it("never tags someone for their own action", () => {
    const events = [anEvent("review_requested", "bob", "bob")];
    expect(handoff(authorOwns("needs_reviewer"), awaitingBob, {}, events)).toBeNull();
  });
});

describe("describeHandoff: other states", () => {
  it.each<[PRStatus["state"], string]>([
    ["conflict", "<@UALICE> — This PR has merge conflicts ⚠️. Resolve them."],
    ["wip_title", '<@UALICE> — The title says WIP 🚧. Convert it to a draft, or drop "WIP" from the title.'],
    ["needs_reviewer", "<@UALICE> — No reviewers are requested 🙋. Request a reviewer."],
  ])("%s", (state, message) => {
    expect(handoff(awaitingBob, authorOwns(state))).toBe(message);
  });

  it("names the newest reviewer for 'reviewed'", () => {
    const pr = {
      reviews: [
        aReview({ author: "bob", state: "commented", submittedAt: at("2026-10-04T00:00:00Z") }),
        aReview({ author: "carol", state: "dismissed", submittedAt: at("2026-10-03T00:00:00Z") }),
      ],
    };
    expect(handoff(awaitingBob, authorOwns("needs_rerequest"), pr)).toBe(
      "<@UALICE> — bob reviewed 💬. Re-request review or merge.",
    );
  });

  it("falls back to an anonymous sentence when the review isn't in the data", () => {
    expect(handoff(awaitingBob, authorOwns("approved"))).toBe("<@UALICE> — Approved ✅. Ready to merge.");
  });
});

describe("describeHandoff: the author acting on their own PR", () => {
  it("doesn't tag the author for retitling their PR as WIP", () => {
    const events = [anEvent("edited", "alice")];
    expect(handoff(awaitingBob, authorOwns("wip_title"), {}, events)).toBeNull();
  });

  it("doesn't tag the author for removing the last reviewer", () => {
    const events = [anEvent("review_request_removed", "alice", "bob")];
    expect(handoff(awaitingBob, authorOwns("needs_reviewer"), {}, events)).toBeNull();
  });

  it("still tags the author when someone else did it", () => {
    const events = [anEvent("review_request_removed", "bob", "bob")];
    expect(handoff(awaitingBob, authorOwns("needs_reviewer"), {}, events)).toBe(
      "<@UALICE> — No reviewers are requested 🙋. Request a reviewer.",
    );
    expect(handoff(awaitingBob, authorOwns("wip_title"), {}, [anEvent("edited", "carol")])).toBe(
      '<@UALICE> — The title says WIP 🚧. Convert it to a draft, or drop "WIP" from the title.',
    );
  });
});

describe("describeHandoff: when nothing is posted", () => {
  it("owners unchanged (a state change alone, or a flicker that settled back)", () => {
    expect(handoff(authorOwns("needs_reviewer"), authorOwns("ci_failing"))).toBeNull();
    expect(handoff(awaitingBob, { state: "awaiting_review", owners: ["Bob"] })).toBeNull();
  });

  it("owners only shrank", () => {
    expect(handoff({ state: "awaiting_review", owners: ["bob", "carol"] }, awaitingBob)).toBeNull();
  });

  it.each<[PRStatus]>([
    [{ state: "draft", owners: ["alice"] }],
    [{ state: "merged", owners: [] }],
    [{ state: "closed", owners: [] }],
  ])("the PR became %o", (after) => {
    expect(handoff(awaitingBob, after)).toBeNull();
  });

  it("nobody is taggable", () => {
    const strangers = testPeople("ghost");
    const reply = describeHandoff({
      before: awaitingBob,
      after: { state: "awaiting_review", owners: ["outsider"] },
      pr: aPR(),
      events: [],
      people: strangers,
    });
    expect(reply).toBeNull();
  });
});

describe("describeHandoff: unmapped owners", () => {
  it("tags the triager instead", () => {
    expect(handoff(authorOwns("needs_reviewer"), { state: "awaiting_review", owners: ["outsider"] })).toBe(
      "<@UDAN> — Your review is requested 👀.",
    );
  });

  it("doesn't tag the triager for their own action", () => {
    const events = [anEvent("review_requested", "dan", "outsider")];
    expect(
      handoff(authorOwns("needs_reviewer"), { state: "awaiting_review", owners: ["outsider"] }, {}, events),
    ).toBeNull();
  });
});

describe("describeHandoff: merge queue", () => {
  const queued: PRStatus = { state: "in_merge_queue", owners: [] };

  it("tags nobody when the PR enters the queue", () => {
    expect(handoff(authorOwns("approved"), queued, {}, [anEvent("enqueued", "alice")])).toBeNull();
    expect(handoff(awaitingBob, queued)).toBeNull();
  });

  it("hands the PR back to the author when it leaves the queue unmerged, saying so", () => {
    const pr = { reviews: [aReview({ author: "bob", state: "approved" })] };
    expect(handoff(queued, authorOwns("approved"), pr, [anEvent("dequeued", "bob")])).toBe(
      "<@UALICE> — Removed from the merge queue 🚂. Next: Merge.",
    );
    expect(handoff(queued, authorOwns("ci_failing"))).toBe(
      "<@UALICE> — Removed from the merge queue 🚂. Next: Fix CI.",
    );
  });

  it("doesn't tag the author for taking their own PR out of the queue", () => {
    expect(handoff(queued, authorOwns("approved"), {}, [anEvent("dequeued", "alice")])).toBeNull();
  });
});
