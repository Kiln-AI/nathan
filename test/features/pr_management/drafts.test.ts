import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { draftNudgesDue, draftNudgeText, nudgeDraftIfDue } from "../../../src/features/pr_management/drafts";
import type { PRData } from "../../../src/github";
import { aPR } from "../../builders/github";
import { type PRTestApp, prApp, prConfig, prContext, sweepAt } from "../../helpers/pr";

// Draft nudges (spec §4.8). aPR() is opened 2026-10-01T15:00Z, so it is 14 days old at
// 2026-10-15T15:00Z.

const config = { nudgeAfterDays: 14, nudgeEveryDays: 7, reportAfterDays: 30 };
const SINCE = DateTime.fromISO("2026-10-01T15:00:00Z", { zone: "utc" });
const LINK = "<https://github.com/Kiln-AI/Kiln/pull/101|Kiln-AI/Kiln#101> Add the thing";

async function draftSeen(h: PRTestApp, overrides: Partial<PRData> = {}) {
  h.github.upsert(aPR({ isDraft: true, ...overrides }));
  await sweepAt(h, "2026-10-05T14:00:00Z");
}

describe("draftNudgesDue", () => {
  it.each([
    [13.9, 0],
    [14, 1],
    [20.9, 1],
    [21, 2],
    [40, 4],
  ])("at %s days old, %s nudges are due", (days, due) => {
    expect(draftNudgesDue(SINCE, SINCE.plus({ days }), config)).toBe(due);
  });
});

describe("draftNudgeText", () => {
  const record = { repo: "Kiln-AI/Kiln", number: 101, title: "Add <the> thing", url: aPR().url, author: "outsider" };

  it("asks the author to finish or close their draft", () => {
    expect(draftNudgeText({ record, days: 14, toAuthor: true })).toBe(
      "Your draft <https://github.com/Kiln-AI/Kiln/pull/101|Kiln-AI/Kiln#101> Add &lt;the&gt; thing is 14 days old — finish it, or close it if it's dead.",
    );
  });

  it("asks the triager to chase a non-team author", () => {
    expect(draftNudgeText({ record, days: 1, toAuthor: false })).toBe(
      "The draft <https://github.com/Kiln-AI/Kiln/pull/101|Kiln-AI/Kiln#101> Add &lt;the&gt; thing by outsider is 1 day old — nudge the author, or close it if it's dead.",
    );
  });
});

describe("draft nudges in the sweep", () => {
  it("DMs the author at 14 days, then weekly", async () => {
    const h = prApp();
    await draftSeen(h);
    await sweepAt(h, "2026-10-15T14:00:00Z");
    expect(h.slack.dms).toEqual([]);

    await sweepAt(h, "2026-10-15T15:00:00Z");
    await sweepAt(h, "2026-10-21T15:00:00Z");
    expect(h.slack.dms).toEqual([
      {
        userId: "UALICE",
        message: { text: `Your draft ${LINK} is 14 days old — finish it, or close it if it's dead.` },
      },
    ]);

    await sweepAt(h, "2026-10-22T15:00:00Z");
    expect(h.slack.dms.map((dm) => dm.message.text)).toEqual([
      expect.stringContaining("is 14 days old"),
      expect.stringContaining("is 21 days old"),
    ]);
    expect(h.slack.posts).toEqual([]);
  });

  it("sends one DM, not a backlog, when a draft is first seen long after it was opened", async () => {
    const h = prApp();
    await draftSeen(h, { createdAt: SINCE.minus({ days: 30 }) });
    expect(h.slack.dms.map((dm) => dm.message.text)).toEqual([expect.stringContaining("is 33 days old")]);
    await sweepAt(h, "2026-10-05T15:00:00Z");
    expect(h.slack.dms).toHaveLength(1);
  });

  it("restarts the age when the PR is converted to draft again", async () => {
    const h = prApp();
    await draftSeen(h);
    await sweepAt(h, "2026-10-15T15:00:00Z");
    expect(h.slack.dms).toHaveLength(1);

    h.github.upsert(aPR());
    await sweepAt(h, "2026-10-16T16:00:00Z");
    const converted = DateTime.fromISO("2026-10-16T17:00:00Z", { zone: "utc" });
    h.github.upsert(aPR({ isDraft: true, lastConvertedToDraftAt: converted }));
    await sweepAt(h, "2026-10-16T17:00:00Z");
    await sweepAt(h, "2026-10-30T16:00:00Z");
    expect(h.slack.dms).toHaveLength(1);

    await sweepAt(h, "2026-10-30T17:00:00Z");
    expect(h.slack.dms.at(-1)?.message.text).toContain("is 14 days old");
  });

  it("DMs the triager about a non-team draft", async () => {
    const h = prApp();
    await draftSeen(h, { author: "outsider" });
    await sweepAt(h, "2026-10-15T15:00:00Z");
    expect(h.slack.dms).toEqual([
      {
        userId: "UDAN",
        message: {
          text: `The draft ${LINK} by outsider is 14 days old — nudge the author, or close it if it's dead.`,
        },
      },
    ]);
  });

  it("DMs nobody when nobody can be reached", async () => {
    const h = prApp({ config: prConfig({ triager: "ghost" }) });
    await draftSeen(h, { author: "outsider" });
    await sweepAt(h, "2026-10-15T15:00:00Z");
    expect(h.slack.dms).toEqual([]);
  });

  it("puts the count back when the DM fails, so the next sweep sends it", async () => {
    const h = prApp();
    await draftSeen(h);
    vi.spyOn(h.slack, "sendDirectMessage").mockRejectedValueOnce(new Error("slack is down"));

    await sweepAt(h, "2026-10-15T15:00:00Z");
    expect(h.log.at("error").map((e) => e.msg)).toContain("slack is down");
    expect((await h.record(101))?.draftNudges.count).toBe(0);

    await sweepAt(h, "2026-10-15T16:00:00Z");
    expect(h.slack.dms).toHaveLength(1);
    expect((await h.record(101))?.draftNudges.count).toBe(1);
  });

  it("sends nothing for a record a refresh has since rewritten", async () => {
    const h = prApp();
    await draftSeen(h);
    const stale = await h.record(101);
    h.clock.set("2026-10-15T15:00:00Z");
    await h.refresh(101);
    if (!stale) throw new Error("expected a record");

    await nudgeDraftIfDue(prContext(h), stale);

    expect(h.slack.dms).toEqual([]);
    expect((await h.record(101))?.draftNudges.count).toBe(0);
  });
});
