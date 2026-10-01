import type { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { RateLimitedError } from "../../../src/github";
import { aPR, aReview } from "../../builders/github";
import { PR_CHANNEL, type PRTestApp, prApp, REPO } from "../../helpers/pr";

const TOP_OF_HOUR = Date.parse("2026-10-05T15:00:00Z");
const SWEEP_SOURCE = "pr_management.sweep";

/** Runs the scheduler tick at 15:00 UTC, when the hourly sweep is due. */
async function runSweep(h: PRTestApp) {
  h.clock.set("2026-10-05T15:00:00Z");
  await h.app.scheduled(TOP_OF_HOUR);
}

const reported = (h: PRTestApp) => h.log.at("error").map((e) => ({ msg: e.msg, source: e.fields.source }));

describe("hourly sweep", () => {
  it("refreshes every open PR from the one sweep query, creating cards where due", async () => {
    const h = prApp();
    h.github.upsert(aPR({ number: 1, pendingReviewers: ["bob"] }));
    h.github.upsert(aPR({ number: 2 }));
    h.github.upsert(aPR({ number: 3, repo: "Kiln-AI/nathan", isDraft: true }));
    const single = vi.spyOn(h.github.reader, "pullRequest");

    await runSweep(h);

    expect(await h.record(1)).toMatchObject({ state: "awaiting_review" });
    expect(await h.record(2)).toMatchObject({ state: "needs_reviewer" });
    expect(await h.record(3, "Kiln-AI/nathan")).toMatchObject({ state: "draft" });
    expect(h.slack.posts).toHaveLength(1);
    expect(single).not.toHaveBeenCalled();
  });

  it("re-reads stored open PRs the sweep no longer returns, finalizing them", async () => {
    const h = prApp();
    h.github.upsert(aPR({ pendingReviewers: ["bob"] }));
    await h.refresh(101);
    const card = (await h.record(101))?.card;
    h.github.upsert(aPR({ state: "merged" }));

    await runSweep(h);

    expect(await h.record(101)).toMatchObject({ state: "merged" });
    expect(JSON.stringify(h.slack.updates.at(-1)?.blocks)).toContain("🟣 *Merged*");
    expect(h.slack.reactions).toEqual([{ ...card, name: "large_purple_circle" }]);
  });

  it("doesn't overwrite a record refreshed with fresher data after the sweep read GitHub", async () => {
    const h = prApp();
    h.github.upsert(aPR({ pendingReviewers: ["bob"] }));
    await h.refresh(101);
    const card = (await h.record(101))?.card;
    const readOpen = h.github.reader.openPullRequests;
    vi.spyOn(h.github.reader, "openPullRequests").mockImplementation(async (repos) => {
      const snapshot = await readOpen(repos);
      // The PR is merged and a job refreshes it while the sweep is still running.
      h.github.upsert(aPR({ state: "merged" }));
      h.clock.advance({ minutes: 1 });
      await h.refresh(101);
      return snapshot;
    });

    await runSweep(h);

    expect(await h.record(101)).toMatchObject({ state: "merged" });
    expect(h.slack.reactions).toEqual([{ ...card, name: "large_purple_circle" }]);
    expect(h.slack.posts).toHaveLength(1);
    expect(JSON.stringify(h.slack.updates.at(-1)?.blocks)).toContain("🟣 *Merged*");
  });

  it("applies its data over a record whose GitHub read was older, even if that record was written later", async () => {
    const h = prApp();
    h.github.upsert(aPR({ pendingReviewers: ["bob"] }));
    await h.refresh(101);
    const stale = aPR({ pendingReviewers: ["bob"] });
    h.github.upsert(aPR({ reviews: [aReview({ author: "bob", state: "approved" })] }));
    const readOpen = h.github.reader.openPullRequests;
    vi.spyOn(h.github.reader, "openPullRequests").mockImplementation(async (repos) => {
      const snapshot = await readOpen(repos);
      // A job read GitHub at 14:59:30 (before this sweep's 15:00 read) and only writes now.
      h.clock.set("2026-10-05T14:59:30Z");
      vi.spyOn(h.github.reader, "pullRequest").mockImplementationOnce(async () => {
        h.clock.set("2026-10-05T15:00:30Z");
        return stale;
      });
      await h.refresh(101);
      return snapshot;
    });

    await runSweep(h);

    expect(await h.record(101)).toMatchObject({ state: "approved" });
    expect(h.slack.posts.at(-1)?.text).toBe("<@UALICE> — bob approved ✅. Ready to merge.");
  });

  it("reports repos GitHub didn't return and leaves their stored PRs alone", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    await h.refresh(101);
    h.github.missingRepos.add(REPO);
    h.github.prs.length = 0;

    await runSweep(h);

    expect(await h.record(101)).toMatchObject({ state: "needs_reviewer" });
    expect(reported(h)).toContainEqual({
      msg: "GitHub didn't return Kiln-AI/Kiln. Is the GitHub App installed there?",
      source: SWEEP_SOURCE,
    });
  });

  it("reports one PR's failure and carries on with the others", async () => {
    const h = prApp();
    h.github.upsert(aPR({ number: 1, pendingReviewers: ["bob"] }));
    h.github.upsert(aPR({ number: 2, pendingReviewers: ["carol"] }));
    vi.spyOn(h.slack, "postMessage").mockRejectedValueOnce(new Error("slack is down"));

    await runSweep(h);

    expect(reported(h)).toContainEqual({ msg: "slack is down", source: SWEEP_SOURCE });
    expect(h.slack.posts.filter((p) => p.channel === PR_CHANNEL)).toHaveLength(1);
    expect((await h.record(2))?.card).not.toBeNull();
  });

  it("stops at a rate limit and leaves the rest to the next sweep", async () => {
    const h = prApp();
    h.github.upsert(aPR({ state: "open" }));
    await h.refresh(101);
    h.github.prs.length = 0;
    vi.spyOn(h.github.reader, "pullRequest").mockRejectedValue(new RateLimitedError("slow down", 60));

    await runSweep(h);

    expect(await h.record(101)).toMatchObject({ state: "needs_reviewer" });
    expect(reported(h)).toEqual([]);
    expect(h.log.at("warn").map((e) => e.msg)).toContain("GitHub rate limit hit; sweep stopped early");
  });

  it("reports a failed sweep query through the scheduler", async () => {
    const h = prApp();
    h.github.fail(new Error("github is down"));
    await runSweep(h);
    expect(reported(h)).toContainEqual({ msg: "github is down", source: SWEEP_SOURCE });
  });

  it("prunes events no refresh consumed within a week", async () => {
    const h = prApp();
    const event = (receivedAt: DateTime) => ({
      event: "status",
      action: null,
      actor: null,
      subject: null,
      receivedAt,
    });
    await h.store.recordEvent("Kiln-AI/old", 1, event(h.clock.now().minus({ days: 8 })));
    await h.store.recordEvent("Kiln-AI/old", 2, event(h.clock.now()));

    await runSweep(h);

    expect(await h.events(1, "Kiln-AI/old")).toEqual([]);
    expect(await h.events(2, "Kiln-AI/old")).toHaveLength(1);
  });
});
