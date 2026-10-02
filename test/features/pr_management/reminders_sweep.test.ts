import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REMINDER_TEMPLATES } from "../../../src/features/pr_management/config";
import type { PRData } from "../../../src/github";
import { aPR, aReview } from "../../builders/github";
import { PR_CHANNEL, type PRTestApp, prApp, prConfig, REPO, sweepAt } from "../../helpers/pr";

// Stale reminders (spec §4.6), driven through the scheduler's hourly sweep.

/** A PR first seen by the sweep at `iso`, which starts its staleness clock. */
async function seenAt(h: PRTestApp, iso: string, overrides: Partial<PRData> = {}) {
  h.github.upsert(aPR(overrides));
  await sweepAt(h, iso);
}

const threadReplies = (h: PRTestApp) => h.slack.posts.filter((post) => post.thread_ts !== undefined);
const reported = (h: PRTestApp) => h.log.at("error").map((e) => e.msg);
const [LEVEL_1, LEVEL_2] = DEFAULT_REMINDER_TEMPLATES as [string[], string[]];

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stale reminders", () => {
  it("posts the missing card, then a level-1 reminder in its thread after 24 working hours", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z");
    await sweepAt(h, "2026-10-06T13:00:00Z");
    expect(h.slack.posts).toEqual([]);

    await sweepAt(h, "2026-10-06T14:00:00Z");

    const card = (await h.record(101))?.card;
    expect(card?.channel).toBe(PR_CHANNEL);
    expect(h.slack.posts).toEqual([
      expect.objectContaining({ channel: PR_CHANNEL, text: "Kiln-AI/Kiln#101 Add the thing: Needs a reviewer" }),
      {
        channel: PR_CHANNEL,
        thread_ts: card?.ts,
        text: `<@UALICE> — ${LEVEL_1[0]}\n*Next step:* Request a reviewer · waiting 1d · opened 4d 23h ago`,
      },
    ]);
  });

  it("doesn't repeat a level, and escalates after another full threshold", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z");
    await sweepAt(h, "2026-10-06T14:00:00Z");
    await sweepAt(h, "2026-10-06T15:00:00Z");
    await sweepAt(h, "2026-10-07T13:00:00Z");
    expect(threadReplies(h)).toHaveLength(1);

    await sweepAt(h, "2026-10-07T14:00:00Z");

    expect(threadReplies(h)).toHaveLength(2);
    expect(threadReplies(h)[1]?.text).toContain(`<@UALICE> — ${LEVEL_2[0]}\n*Next step:* Request a reviewer`);
    expect((await h.record(101))?.reminders).toMatchObject({
      sent: { alice: { level: 2, at: h.clock.now() } },
      lastVariant: "1:0",
    });
  });

  it("doesn't count weekend hours in the owner's time zone", async () => {
    const h = prApp();
    // Friday 10:00 in Toronto; 14 working hours left that day, 10 more by Monday 10:00.
    await seenAt(h, "2026-10-09T14:00:00Z");
    await sweepAt(h, "2026-10-12T13:00:00Z");
    expect(threadReplies(h)).toEqual([]);

    await sweepAt(h, "2026-10-12T14:00:00Z");
    expect(threadReplies(h)).toHaveLength(1);
  });

  it("times each owner in their own zone, tagging only those overdue", async () => {
    const h = prApp();
    h.slack.timeZones.set("UBOB", "Asia/Shanghai");
    // Thursday 14:00 in Toronto, Friday 02:00 in Shanghai.
    await seenAt(h, "2026-10-08T18:00:00Z", { author: "carol", pendingReviewers: ["alice", "bob"] });

    // Friday 14:00 in Toronto: alice is due. It's already Saturday in Shanghai, with bob 2h short.
    await sweepAt(h, "2026-10-09T18:00:00Z");
    expect(threadReplies(h).map((post) => post.text.split(" — ")[0])).toEqual(["<@UALICE>"]);

    // Monday 02:00 in Shanghai: bob's weekend is over and he's due.
    await sweepAt(h, "2026-10-11T18:00:00Z");
    expect(threadReplies(h).map((post) => post.text.split(" — ")[0])).toEqual(["<@UALICE>", "<@UBOB>"]);
  });

  it("starts over after a state or owner change, avoiding the variant used last", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z", { pendingReviewers: ["bob"] });
    await sweepAt(h, "2026-10-06T14:00:00Z");
    expect(threadReplies(h).at(-1)?.text).toContain(`<@UBOB> — ${LEVEL_1[0]}`);

    h.github.upsert(aPR({ reviews: [aReview({ author: "bob", state: "approved" })] }));
    await sweepAt(h, "2026-10-06T15:00:00Z");
    expect(threadReplies(h).at(-1)?.text).toBe("<@UALICE> — bob approved ✅. Ready to merge.");
    await sweepAt(h, "2026-10-07T14:00:00Z");
    expect(threadReplies(h)).toHaveLength(2);

    await sweepAt(h, "2026-10-07T15:00:00Z");
    expect(threadReplies(h).at(-1)?.text).toBe(
      `<@UALICE> — ${LEVEL_1[1]}\n*Next step:* Merge · waiting 1d · opened 6d ago`,
    );
  });

  it("reminds urgent PRs after 4 hours", async () => {
    const h = prApp();
    h.github.upsert(aPR({ pendingReviewers: ["bob"], labels: ["urgent"] }));
    await h.runJob("post_review_request", {
      repo: REPO,
      number: 101,
      reviewers: ["bob"],
      modifiers: ["urgent"],
      note: null,
      submittedBy: "UALICE",
    });
    await sweepAt(h, "2026-10-05T17:00:00Z");
    expect(threadReplies(h)).toEqual([]);

    await sweepAt(h, "2026-10-05T18:00:00Z");
    expect(threadReplies(h).map((post) => post.text.split(" — ")[0])).toEqual(["<@UBOB>"]);
  });

  it("starts at level 1 when a long-waiting PR is marked urgent, then escalates one level per 4 hours", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z", { pendingReviewers: ["bob"] });
    h.clock.set("2026-10-06T12:00:00Z");
    h.github.upsert(aPR({ pendingReviewers: ["bob"], labels: ["urgent"] }));
    await h.runJob("post_review_request", {
      repo: REPO,
      number: 101,
      reviewers: ["bob"],
      modifiers: ["urgent"],
      note: null,
      submittedBy: "UALICE",
    });
    const reminders = () => threadReplies(h).filter((post) => post.text.includes("*Next step:*"));

    await sweepAt(h, "2026-10-06T12:00:00Z");
    expect(reminders().map((post) => post.text.split("\n")[0])).toEqual([`<@UBOB> — ${LEVEL_1[0]}`]);
    await sweepAt(h, "2026-10-06T15:00:00Z");
    expect(reminders()).toHaveLength(1);

    await sweepAt(h, "2026-10-06T16:00:00Z");
    expect(reminders().map((post) => post.text.split("\n")[0])).toEqual([
      `<@UBOB> — ${LEVEL_1[0]}`,
      `<@UBOB> — ${LEVEL_2[0]}`,
    ]);
  });

  it("times the next reminder from the last one, so a late one doesn't bring the next forward", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z");
    // The sweeps from Tuesday 14:00 to 19:00 were missed.
    await sweepAt(h, "2026-10-06T20:00:00Z");
    expect(threadReplies(h)).toHaveLength(1);

    await sweepAt(h, "2026-10-07T19:00:00Z");
    expect(threadReplies(h)).toHaveLength(1);
    await sweepAt(h, "2026-10-07T20:00:00Z");
    expect(threadReplies(h)).toHaveLength(2);
  });

  it("doesn't remind about a PR a newer refresh finalized during the sweep", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z", { pendingReviewers: ["bob"] });
    const readOpen = h.github.reader.openPullRequests;
    vi.spyOn(h.github.reader, "openPullRequests").mockImplementation(async (repos) => {
      const snapshot = await readOpen(repos);
      h.github.upsert(aPR({ state: "merged" }));
      h.clock.advance({ minutes: 1 });
      await h.refresh(101);
      return snapshot;
    });

    await sweepAt(h, "2026-10-06T14:00:00Z");

    expect(await h.record(101)).toMatchObject({ state: "merged" });
    expect(threadReplies(h)).toEqual([]);
  });

  it("uses a state's own threshold from config", async () => {
    const h = prApp({ config: prConfig({ reminders: { thresholdHoursByState: { needs_reviewer: 2 } } }) });
    await seenAt(h, "2026-10-05T14:00:00Z");
    await sweepAt(h, "2026-10-05T16:00:00Z");
    expect(threadReplies(h)).toHaveLength(1);
    await sweepAt(h, "2026-10-05T18:00:00Z");
    expect(threadReplies(h)).toHaveLength(2);
  });

  it("never reminds about drafts", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z", { isDraft: true });
    await sweepAt(h, "2026-10-08T14:00:00Z");
    expect(h.slack.posts).toEqual([]);
  });

  it("never reminds about a PR waiting in the merge queue", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z", { isInMergeQueue: true });
    await sweepAt(h, "2026-10-08T14:00:00Z");
    expect(h.slack.posts).toEqual([]);
    expect(await h.record(101)).toMatchObject({ state: "in_merge_queue", card: null });
  });

  it("tags the triager for an unmapped owner", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z", { pendingReviewers: ["stranger"] });
    await sweepAt(h, "2026-10-06T14:00:00Z");
    expect(threadReplies(h).map((post) => post.text.split(" — ")[0])).toEqual(["<@UDAN>"]);
  });

  it("posts nothing, not even a card, when nobody can be tagged", async () => {
    const h = prApp({ config: prConfig({ triager: "ghost" }) });
    await seenAt(h, "2026-10-05T14:00:00Z", { author: "outsider" });
    await sweepAt(h, "2026-10-06T14:00:00Z");
    expect(h.slack.posts).toEqual([]);
    expect((await h.record(101))?.card).toBeNull();
  });

  it("skips a PR whose refresh failed, and reminds on the next sweep", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z", { pendingReviewers: ["bob"] });
    vi.spyOn(h.slack, "updateMessage").mockRejectedValueOnce(new Error("slack is down"));

    await sweepAt(h, "2026-10-06T14:00:00Z");
    expect(reported(h)).toContain("slack is down");
    expect(threadReplies(h)).toEqual([]);

    await sweepAt(h, "2026-10-06T15:00:00Z");
    expect(threadReplies(h)).toHaveLength(1);
  });

  it("leaves the reminder to the next sweep when a refresh writes the PR meanwhile", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z", { pendingReviewers: ["bob"] });
    // The owner's time zone lookup is where a webhook-driven refresh lands mid-reminder.
    vi.spyOn(h.slack, "userTimeZone").mockImplementationOnce(async () => {
      await h.refresh(101);
      return null;
    });

    await sweepAt(h, "2026-10-06T14:00:00Z");
    expect(threadReplies(h)).toEqual([]);

    await sweepAt(h, "2026-10-06T15:00:00Z");
    expect(threadReplies(h)).toHaveLength(1);
  });

  it("waits for a card another refresh is posting, then reminds in it", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z");
    h.clock.set("2026-10-06T13:59:00Z");
    expect(await h.store.claimCard(REPO, 101, h.clock.now(), h.clock.now().minus({ minutes: 5 }))).toBe(true);

    await sweepAt(h, "2026-10-06T14:00:00Z");
    expect(h.slack.posts).toEqual([]);

    await sweepAt(h, "2026-10-06T15:00:00Z");
    expect(h.slack.posts).toHaveLength(2);
    expect(threadReplies(h)).toHaveLength(1);
  });

  it("puts the levels back when the reply fails, so the next sweep sends it", async () => {
    const h = prApp();
    await seenAt(h, "2026-10-05T14:00:00Z", { pendingReviewers: ["bob"] });
    vi.spyOn(h.slack, "postMessage").mockRejectedValueOnce(new Error("slack is down"));

    await sweepAt(h, "2026-10-06T14:00:00Z");
    expect(reported(h)).toContain("slack is down");
    expect((await h.record(101))?.reminders).toMatchObject({ sent: {}, lastVariant: null });

    await sweepAt(h, "2026-10-06T15:00:00Z");
    expect(threadReplies(h).map((post) => post.text.split(" — ")[0])).toEqual(["<@UBOB>"]);
    expect((await h.record(101))?.reminders).toMatchObject({
      sent: { bob: { level: 1 } },
      lastVariant: "0:0",
    });
  });
});
