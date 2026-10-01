import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_CLEAR_TEXT,
  buildReport,
  CONTINUED_TEXT,
  type ReportInput,
  type ReportMessage,
} from "../../../src/features/pr_management/report";
import { OPEN_REQUEST_PR_ACTION } from "../../../src/features/pr_management/request_form";
import { GitHubApiError } from "../../../src/github";
import { MAX_MESSAGE_BLOCKS, MAX_SECTION_TEXT } from "../../../src/slack";
import { aPR, aPRHistory, aReview } from "../../builders/github";
import { aRecord } from "../../builders/pr_record";
import { PR_CHANNEL, type PRTestApp, prApp, prConfig, REPO } from "../../helpers/pr";

const at = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });

// Tuesday 2026-10-20, 09:30 in New York (EDT).
const SLOT = at("2026-10-20T13:30:00Z");
const NOW = SLOT.plus({ minutes: 1 });

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    slot: SLOT,
    now: NOW,
    since: at("2026-10-19T13:30:00Z"),
    timezone: "America/New_York",
    weekly: false,
    previousOpenCount: null,
    records: [],
    overdue: new Map(),
    history: [],
    team: ["alice", "bob", "carol", "dan"],
    triager: "dan",
    oldDraftDays: 30,
    ...overrides,
  };
}

/** Every mrkdwn line of the report, in order. */
function lines(messages: readonly ReportMessage[]): string[] {
  return messages.flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === "section" && block.text ? block.text.text.split("\n") : [])),
  );
}

const report = (overrides: Partial<ReportInput> = {}) => lines(buildReport(input(overrides)));
const daysAgo = (days: number) => NOW.minus({ days });

describe("buildReport golden files", () => {
  it("a busy Monday with every section", async () => {
    const monday = at("2026-10-19T13:30:00Z");
    const now = monday.plus({ minutes: 1 });
    const records = [
      aRecord({
        number: 1,
        title: "Speed up the <indexer>",
        createdAt: now.minus({ days: 6 }),
        state: "changes_requested",
        owners: ["alice"],
      }),
      aRecord({
        number: 2,
        author: "carol",
        createdAt: now.minus({ days: 3 }),
        state: "awaiting_review",
        owners: ["alice", "bob"],
      }),
      aRecord({ number: 3, author: "bob", createdAt: now.minus({ hours: 5 }), state: "approved", owners: ["bob"] }),
      aRecord({
        number: 4,
        author: "outsider",
        category: "oss",
        createdAt: now.minus({ days: 12 }),
        state: "awaiting_review",
        owners: ["carol"],
      }),
      aRecord({
        number: 5,
        repo: "Kiln-AI/nathan",
        title: "Bump luxon from 3.7.1 to 3.7.2",
        author: "dependabot[bot]",
        category: "dependabot",
        createdAt: now.minus({ days: 2 }),
        state: "ci_failing",
        owners: ["dan"],
      }),
      aRecord({
        number: 6,
        author: "carol",
        state: "draft",
        owners: ["carol"],
        createdAt: now.minus({ days: 60 }),
        draftSince: now.minus({ days: 40 }),
      }),
    ];
    const history = [
      aPRHistory({
        number: 7,
        author: "bob",
        createdAt: now.minus({ days: 4 }),
        mergedAt: now.minus({ days: 2 }),
        closedAt: now.minus({ days: 2 }),
        reviews: [aReview({ author: "alice", submittedAt: now.minus({ days: 3 }) })],
      }),
      aPRHistory({
        number: 8,
        author: "alice",
        createdAt: now.minus({ days: 12 }),
        mergedAt: now.minus({ days: 9 }),
        closedAt: now.minus({ days: 9 }),
        reviews: [aReview({ author: "bob", submittedAt: now.minus({ days: 11 }) })],
      }),
    ];
    const messages = buildReport(
      input({
        slot: monday,
        now,
        since: at("2026-10-16T13:30:00Z"),
        weekly: true,
        previousOpenCount: 4,
        records,
        overdue: new Map([
          ["Kiln-AI/Kiln#1", ["alice"]],
          ["Kiln-AI/Kiln#2", ["alice", "bob"]],
          ["Kiln-AI/nathan#5", ["dan"]],
        ]),
        history,
      }),
    );
    await expect(`${JSON.stringify(messages, null, 2)}\n`).toMatchFileSnapshot("__snapshots__/report_monday.json");
  });

  it("a quiet day", async () => {
    await expect(`${JSON.stringify(buildReport(input()), null, 2)}\n`).toMatchFileSnapshot(
      "__snapshots__/report_all_clear.json",
    );
  });
});

describe("buildReport headline", () => {
  const open = [aRecord({ number: 1, createdAt: daysAgo(1) }), aRecord({ number: 2, createdAt: daysAgo(4) })];

  it.each([
    [null, "*2* open PRs"],
    [1, "*2* open PRs (+1 since the last report)"],
    [5, "*2* open PRs (−3 since the last report)"],
    [2, "*2* open PRs (no change since the last report)"],
  ])("shows the change from %s open PRs last time", (previousOpenCount, expected) => {
    expect(report({ records: open, previousOpenCount })).toContain(expected);
  });

  it("counts PRs opened and merged since the last report", () => {
    const history = [
      aPRHistory({ number: 1, createdAt: daysAgo(0.5), mergedAt: daysAgo(0.1) }),
      aPRHistory({ number: 2, createdAt: daysAgo(0.5), state: "open", mergedAt: null, closedAt: null }),
      aPRHistory({ number: 3, createdAt: daysAgo(5), mergedAt: daysAgo(0.2) }),
      aPRHistory({ number: 4, createdAt: daysAgo(5), mergedAt: daysAgo(2) }),
    ];
    expect(report({ records: open, history })).toContain("*2* opened · *2* merged since Mon Oct 19");
  });

  it("gives the median and mean age of open non-draft PRs", () => {
    const records = [...open, aRecord({ number: 3, createdAt: daysAgo(10) }), aRecord({ number: 9, state: "draft" })];
    expect(report({ records })).toContain("Age: median *4d* · mean *5d*");
  });

  it("says all clear when no non-draft PR is open, singular counts", () => {
    const quiet = report({ records: [aRecord({ state: "draft" })] });
    expect(quiet).toContain(ALL_CLEAR_TEXT);
    expect(quiet.some((line) => line.startsWith("Age:"))).toBe(false);
    expect(report({ records: [aRecord()] })).toContain("*1* open PR");
  });

  it("leads with a dated header and the Request PR button", () => {
    const [first] = buildReport(input());
    expect(first.blocks[0]).toMatchObject({ type: "header", text: { text: "PR report · Tue Oct 20" } });
    expect(JSON.stringify(first.blocks)).toContain(`"action_id":"${OPEN_REQUEST_PR_ACTION}"`);
    expect(first.text).toBe("PR report for Tue Oct 20: 0 open PRs");
  });
});

describe("buildReport sections", () => {
  it("groups stale PRs by overdue owner, oldest PR first, leaving out Dependabot and PRs on time", () => {
    const records = [
      aRecord({ number: 1, author: "bob", createdAt: daysAgo(2), state: "awaiting_review", owners: ["Alice"] }),
      aRecord({ number: 2, createdAt: daysAgo(9), state: "awaiting_review", owners: ["alice", "carol"] }),
      aRecord({ number: 3, createdAt: daysAgo(5), state: "approved", owners: ["bob"] }),
      aRecord({ number: 4, createdAt: daysAgo(20), state: "conflict", owners: ["bob"] }),
      aRecord({ number: 5, category: "dependabot", author: "dependabot[bot]", owners: ["dan"] }),
    ];
    const overdue = new Map([
      ["Kiln-AI/Kiln#1", ["Alice"]],
      ["Kiln-AI/Kiln#2", ["alice", "carol"]],
      ["Kiln-AI/Kiln#3", ["bob"]],
      ["Kiln-AI/Kiln#5", ["dan"]],
    ]);
    const messages = buildReport(input({ records, overdue }));
    const shown = lines(messages);
    const start = shown.indexOf("*Needs attention* (3)");
    expect(shown.slice(start, start + 7).map((line) => line.split(" · ")[0])).toEqual([
      "*Needs attention* (3)",
      "*alice*",
      "• <https://github.com/Kiln-AI/Kiln/pull/2|Kiln-AI/Kiln#2> Add the thing",
      "• <https://github.com/Kiln-AI/Kiln/pull/1|Kiln-AI/Kiln#1> Add the thing",
      "*carol*",
      "• <https://github.com/Kiln-AI/Kiln/pull/2|Kiln-AI/Kiln#2> Add the thing",
      "*bob*",
    ]);
    expect(shown[start + 2]).toBe(
      "• <https://github.com/Kiln-AI/Kiln/pull/2|Kiln-AI/Kiln#2> Add the thing · 👀 Awaiting review · Next: Review · 1w 2d",
    );
    expect(shown.join("\n")).not.toContain("Kiln#4");
    expect(messages[0].text).toBe("PR report for Tue Oct 20: 5 open PRs, 3 need attention");
  });

  it("lists OSS PRs with their owners and the triager, and Dependabot PRs compactly", () => {
    const records = [
      aRecord({ number: 1, category: "oss", author: "outsider", state: "awaiting_review", owners: ["bob", "carol"] }),
      aRecord({ number: 2, category: "dependabot", author: "dependabot[bot]", state: "approved", owners: ["dan"] }),
    ];
    const shown = report({ records });
    expect(shown).toContain("*OSS contributors* (1, triager dan)");
    expect(shown).toContain(
      "• <https://github.com/Kiln-AI/Kiln/pull/1|Kiln-AI/Kiln#1> Add the thing · 👀 Awaiting review · Next: Review · Owners: bob, carol · 2w 4d",
    );
    expect(shown).toContain("*Dependabot* (1)");
    expect(shown).toContain(
      "• <https://github.com/Kiln-AI/Kiln/pull/2|Kiln-AI/Kiln#2> Add the thing · ✅ Approved · Owner: dan · 2w 4d",
    );
  });

  it("names no owner for OSS and Dependabot PRs in the merge queue", () => {
    const queued = { state: "in_merge_queue" as const, owners: [] };
    const records = [
      aRecord({ number: 1, category: "oss", author: "outsider", ...queued }),
      aRecord({ number: 2, category: "dependabot", author: "dependabot[bot]", ...queued }),
    ];
    const shown = report({ records });
    expect(shown).toContain(
      "• <https://github.com/Kiln-AI/Kiln/pull/1|Kiln-AI/Kiln#1> Add the thing · 🚂 In merge queue · Next: Wait for merge queue · 2w 4d",
    );
    expect(shown).toContain(
      "• <https://github.com/Kiln-AI/Kiln/pull/2|Kiln-AI/Kiln#2> Add the thing · 🚂 In merge queue · 2w 4d",
    );
  });

  it("lists drafts at least 30 days old, by how long they've been drafts", () => {
    const records = [
      aRecord({ number: 1, state: "draft", draftSince: daysAgo(29) }),
      aRecord({ number: 2, state: "draft", draftSince: daysAgo(45), author: "bob" }),
      aRecord({ number: 3, state: "draft", draftSince: null, createdAt: daysAgo(31) }),
    ];
    const shown = report({ records });
    expect(shown).toContain("*Old drafts* (2, over 30 days)");
    expect(shown.filter((line) => line.startsWith("• "))).toEqual([
      "• <https://github.com/Kiln-AI/Kiln/pull/2|Kiln-AI/Kiln#2> Add the thing · by bob · 6w 3d",
      "• <https://github.com/Kiln-AI/Kiln/pull/3|Kiln-AI/Kiln#3> Add the thing · by alice · 4w 3d",
    ]);
  });

  it("omits empty sections, and the weekly ones except on Mondays", () => {
    const history = [aPRHistory({ createdAt: daysAgo(3), mergedAt: daysAgo(1), closedAt: daysAgo(1) })];
    const headings = (shown: string[]) =>
      shown.flatMap(
        (line) => /^\*(Needs attention|OSS contributors|Dependabot|Old drafts|Trends|People)\*/.exec(line)?.[1] ?? [],
      );
    expect(headings(report({ history }))).toEqual([]);
    expect(headings(report({ history, weekly: true }))).toEqual(["Trends", "People"]);
  });

  it("shows this week's trends against the week before, with dashes where there's no data", () => {
    const history = [
      aPRHistory({
        number: 1,
        createdAt: daysAgo(3),
        mergedAt: daysAgo(1),
        closedAt: daysAgo(1),
        reviews: [aReview({ submittedAt: daysAgo(2.5) })],
      }),
      aPRHistory({ number: 2, author: "outsider", createdAt: daysAgo(3), mergedAt: daysAgo(1) }),
    ];
    const shown = report({ history, weekly: true });
    expect(shown.slice(shown.indexOf("*Trends* (team PRs, last 7 days)") + 1).slice(0, 4)).toEqual([
      "• Median time to first review: *12h* (the week before: —)",
      "• Median time to merge: *2d* (the week before: —)",
      "• PRs merged: *1* (the week before: 0)",
      "• Median open PR age: *—* (the week before: —)",
    ]);
  });

  it("leaves out Trends without any team activity, and People without a team", () => {
    const shown = report({ weekly: true, team: [], history: [aPRHistory({ author: "outsider" })] });
    expect(shown.some((line) => line.startsWith("*Trends*") || line.startsWith("*People*"))).toBe(false);
  });

  it("gives each team member's week", () => {
    const records = [aRecord({ number: 1, author: "bob", state: "awaiting_review", owners: ["alice"] })];
    const history = [
      aPRHistory({
        number: 2,
        author: "carol",
        mergedAt: daysAgo(1),
        reviews: [aReview({ author: "alice", submittedAt: daysAgo(2) })],
      }),
    ];
    const shown = report({ records, history, weekly: true, team: ["alice", "bob"] });
    expect(shown.slice(shown.indexOf("*People* (last 7 days)") + 1)).toEqual([
      "• alice: 0 open · 1 review waiting on them · 0 merged · 1 PR reviewed",
      "• bob: 1 open · 0 reviews waiting on them · 0 merged · 0 PRs reviewed",
    ]);
  });
});

describe("buildReport splitting", () => {
  it("splits a report too big for one message, continuing in the thread", () => {
    const records = Array.from({ length: 900 }, (_, i) =>
      aRecord({
        number: i + 1,
        title: `A very long PR title that keeps going and going to fill the line ${"x".repeat(40)}`,
        category: "oss",
        author: "outsider",
        state: "awaiting_review",
        owners: ["bob"],
      }),
    );
    const messages = buildReport(input({ records }));

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.blocks.length).toBeLessThanOrEqual(MAX_MESSAGE_BLOCKS);
      for (const block of message.blocks) {
        if (block.type === "section") expect(block.text?.text.length).toBeLessThanOrEqual(MAX_SECTION_TEXT);
      }
    }
    expect(messages[0].blocks).toHaveLength(MAX_MESSAGE_BLOCKS);
    expect(messages[0].blocks.at(-1)).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: CONTINUED_TEXT }],
    });
    expect(messages[1]?.text).toBe("PR report for Tue Oct 20: 900 open PRs (part 2)");
    // Nothing is lost: every PR is listed once.
    expect(lines(messages).filter((line) => line.startsWith("• "))).toHaveLength(900);
  });
});

// ---- Through the scheduler -----------------------------------------------------------------

/** Ticks the scheduler at `iso`. */
async function tickAt(h: PRTestApp, iso: string) {
  h.clock.set(iso);
  await h.app.scheduled(Date.parse(iso));
}

const reports = (h: PRTestApp) => h.slack.posts.filter((post) => post.text.startsWith("PR report"));
const reportLines = (h: PRTestApp, index = -1) => {
  const post = reports(h).at(index);
  return post ? lines([{ text: post.text, blocks: post.blocks ?? [] }]) : [];
};

describe("the daily report task", () => {
  it("posts at 09:30 New York time on weekdays, after sweeping", async () => {
    const h = prApp();
    h.github.upsert(aPR({ pendingReviewers: ["bob"] }));

    await tickAt(h, "2026-10-09T13:15:00Z");
    expect(h.slack.posts).toEqual([]);
    await tickAt(h, "2026-10-09T13:30:00Z");

    // The sweep posted the card first.
    expect(h.slack.posts.map((post) => post.text)).toEqual([
      "Kiln-AI/Kiln#101 Add the thing: Awaiting review",
      "PR report for Fri Oct 9: 1 open PR",
    ]);
    expect(h.slack.posts[1]?.channel).toBe(PR_CHANNEL);

    // Saturday's and Sunday's slots don't exist; Monday's does.
    await tickAt(h, "2026-10-10T13:30:00Z");
    await tickAt(h, "2026-10-11T13:30:00Z");
    expect(reports(h)).toHaveLength(1);
    await tickAt(h, "2026-10-12T13:30:00Z");
    expect(reports(h).map((post) => post.text)).toEqual([
      "PR report for Fri Oct 9: 1 open PR",
      "PR report for Mon Oct 12: 1 open PR, 1 needs attention",
    ]);
  });

  it("covers the time since the last report and shows the change in open PRs", async () => {
    const h = prApp();
    h.github.upsert(aPR({ number: 1, createdAt: at("2026-10-08T10:00:00Z") }));
    await tickAt(h, "2026-10-08T13:30:00Z");
    expect(reportLines(h)).toContain("*1* open PR");

    h.github.upsert(aPR({ number: 2, createdAt: at("2026-10-08T20:00:00Z") }));
    h.github.history.push(
      aPRHistory({
        number: 2,
        state: "open",
        createdAt: at("2026-10-08T20:00:00Z"),
        updatedAt: at("2026-10-08T20:00:00Z"),
        mergedAt: null,
        closedAt: null,
      }),
    );
    await tickAt(h, "2026-10-09T13:30:00Z");

    expect(reportLines(h)).toEqual(
      expect.arrayContaining(["*2* open PRs (+1 since the last report)", "*1* opened · *0* merged since Thu Oct 8"]),
    );
  });

  it("adds Trends and People on Mondays, covering the weekend since Friday", async () => {
    const h = prApp();
    h.github.history.push(
      aPRHistory({
        author: "bob",
        createdAt: at("2026-10-07T10:00:00Z"),
        mergedAt: at("2026-10-09T10:00:00Z"),
        closedAt: at("2026-10-09T10:00:00Z"),
      }),
    );
    const recent = vi.spyOn(h.github.reader, "recentPullRequests");
    await tickAt(h, "2026-10-09T13:30:00Z");
    expect(reportLines(h).some((line) => line.startsWith("*Trends*"))).toBe(false);

    await tickAt(h, "2026-10-12T13:30:00Z");

    const shown = reportLines(h);
    expect(shown).toContain("*0* opened · *0* merged since Fri Oct 9");
    expect(shown).toContain("• PRs merged: *1* (the week before: 0)");
    expect(shown).toContain("• bob: 0 open · 0 reviews waiting on them · 1 merged · 0 PRs reviewed");
    // Monday reads two weeks of history for the trends.
    expect(recent.mock.calls.at(-1)?.[1].toISO()).toBe("2026-09-28T13:30:00.000Z");
  });

  it("still posts from the stored records when the sweep fails", async () => {
    const h = prApp();
    h.github.upsert(aPR({ pendingReviewers: ["bob"] }));
    h.clock.set("2026-10-08T12:00:00Z");
    await h.refresh(101);
    vi.spyOn(h.github.reader, "openPullRequests").mockRejectedValue(new GitHubApiError("Bad credentials", 401));

    await tickAt(h, "2026-10-09T13:30:00Z");

    expect(h.log.at("error").map((e) => [e.msg, e.fields.source])).toContainEqual([
      "Bad credentials",
      "pr_management.daily_report",
    ]);
    expect(reportLines(h)).toContain("*1* open PR");
  });

  it("finds overdue owners in their own time zones", async () => {
    const h = prApp({ config: prConfig({ reminders: { thresholdHoursByState: { awaiting_review: 12 } } }) });
    h.slack.timeZones.set("UBOB", "Asia/Shanghai");
    h.github.upsert(aPR({ author: "carol", pendingReviewers: ["alice", "bob"] }));
    // Sunday 08:00 in Toronto, Sunday 20:00 in Shanghai.
    h.clock.set("2026-10-11T12:00:00Z");
    await h.refresh(101);

    // Monday 09:30 in Toronto (9.5 working hours), 21:30 in Shanghai (21.5).
    await tickAt(h, "2026-10-12T13:30:00Z");

    const shown = reportLines(h);
    expect(shown).toContain("*bob*");
    expect(shown).not.toContain("*alice*");
  });

  it("times owners nobody can be told about in the report's zone", async () => {
    const h = prApp({ config: prConfig({ triager: "zed" }) });
    h.github.upsert(aPR({ author: "outsider" }));
    h.clock.set("2026-10-07T13:30:00Z");
    await h.refresh(101);

    await tickAt(h, "2026-10-08T13:30:00Z");

    expect(reportLines(h)).toContain("*zed*");
  });

  it("posts the rest of a split report in the first message's thread", async () => {
    const h = prApp();
    vi.spyOn(h.github.reader, "openPullRequests").mockRejectedValue(new GitHubApiError("down", 502));
    for (let number = 1; number <= 900; number++) {
      await h.store.insert(
        aRecord({
          repo: REPO,
          number,
          title: `A very long PR title that keeps going and going to fill the line ${"x".repeat(40)}`,
          category: "oss",
          author: "outsider",
          state: "awaiting_review",
          owners: ["bob"],
          stateSince: at("2026-10-09T13:00:00Z"),
        }),
      );
    }

    await tickAt(h, "2026-10-09T13:30:00Z");

    const [first, ...rest] = reports(h);
    expect(first?.thread_ts).toBeUndefined();
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((post) => post.thread_ts !== undefined && post.channel === PR_CHANNEL)).toBe(true);
  });
});
