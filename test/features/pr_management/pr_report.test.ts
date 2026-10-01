import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { ACK_TEXT } from "../../../src/features/pr_management/pr_report";
import { GitHubApiError } from "../../../src/github";
import type { MessageBlock } from "../../../src/slack";
import { aPR, aPRHistory } from "../../builders/github";
import { aRecord } from "../../builders/pr_record";
import { type PRTestApp, prApp, REPO } from "../../helpers/pr";
import { commandBody, signedSlackRequest } from "../../helpers/slack";

const at = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });

async function send(h: PRTestApp, body: string) {
  const ctx = createExecutionContext();
  const response = await h.app.fetch(await signedSlackRequest(body), ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, text };
}

const dms = (h: PRTestApp) => h.slack.dms;
const PR_CHANNEL = "CPRS";
const channelReports = (h: PRTestApp) =>
  h.slack.posts.filter((p) => p.channel === PR_CHANNEL && p.text.startsWith("PR report"));

/** Every mrkdwn line from blocks. */
function sectionLines(blocks: readonly MessageBlock[]): string[] {
  return blocks.flatMap((block) => (block.type === "section" && block.text ? block.text.text.split("\n") : []));
}

/** Ticks the scheduler at `iso` so a scheduled report is recorded. */
async function tickAt(h: PRTestApp, iso: string) {
  h.clock.set(iso);
  await h.app.scheduled(Date.parse(iso));
}

describe("/nathan pr_report", () => {
  it("acks with a brief message and sends the report as a DM", async () => {
    const h = prApp();
    h.github.upsert(aPR({ pendingReviewers: ["bob"] }));
    h.clock.set("2026-10-09T15:00:00Z");
    await h.refresh(101);

    const result = await send(h, commandBody("pr_report"));

    expect(result.status).toBe(200);
    expect(result.text).toBe(ACK_TEXT);
    expect(dms(h)).toHaveLength(1);
    expect(dms(h)[0]?.userId).toBe("UALICE");
    expect(dms(h)[0]?.message.text).toContain("PR report");
    expect(dms(h)[0]?.message.text).toContain("1 open PR");
  });

  it("does not post to the PR channel", async () => {
    const h = prApp();
    h.clock.set("2026-10-09T15:00:00Z");
    await send(h, commandBody("pr_report"));

    expect(channelReports(h)).toHaveLength(0);
  });

  it("does not record the report, so the next scheduled one is unaffected", async () => {
    const h = prApp();
    h.github.upsert(aPR({ number: 1, createdAt: at("2026-10-08T10:00:00Z") }));

    // A scheduled report at 09:30 records open count = 1.
    await tickAt(h, "2026-10-08T13:30:00Z");
    expect(channelReports(h)).toHaveLength(1);

    // On-demand report at 14:00: a second PR exists now.
    h.github.upsert(aPR({ number: 2, createdAt: at("2026-10-08T14:00:00Z") }));
    h.clock.set("2026-10-08T18:00:00Z");
    await send(h, commandBody("pr_report"));
    expect(dms(h)).toHaveLength(1);

    // Next scheduled report should still compare against the 09:30 report (open count = 1),
    // not the on-demand one. The blocks contain "+1 since the last report".
    await tickAt(h, "2026-10-09T13:30:00Z");
    const lastReport = channelReports(h).at(-1);
    const lines = sectionLines((lastReport?.blocks ?? []) as MessageBlock[]);
    expect(lines.some((line) => line.includes("+1 since the last report"))).toBe(true);
  });

  it("includes weekly sections on Monday", async () => {
    const h = prApp();
    h.github.history.push(
      aPRHistory({
        author: "bob",
        createdAt: at("2026-10-05T10:00:00Z"),
        mergedAt: at("2026-10-07T10:00:00Z"),
        closedAt: at("2026-10-07T10:00:00Z"),
      }),
    );
    // Monday in New York (EDT, UTC-4).
    h.clock.set("2026-10-12T16:00:00Z");
    await send(h, commandBody("pr_report"));

    const lines = sectionLines((dms(h)[0]?.message.blocks ?? []) as MessageBlock[]);
    expect(lines.some((line) => line.startsWith("*Trends*"))).toBe(true);
    expect(lines.some((line) => line.startsWith("*People*"))).toBe(true);
  });

  it("does not include weekly sections on a non-Monday", async () => {
    const h = prApp();
    // Wednesday in New York.
    h.clock.set("2026-10-07T16:00:00Z");
    await send(h, commandBody("pr_report"));

    const lines = sectionLines((dms(h)[0]?.message.blocks ?? []) as MessageBlock[]);
    expect(lines.some((line) => line.startsWith("*Trends*"))).toBe(false);
  });

  it("threads multi-part reports in the DM", async () => {
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
    h.clock.set("2026-10-09T15:00:00Z");

    await send(h, commandBody("pr_report"));

    // First part is a DM.
    expect(dms(h)).toHaveLength(1);
    expect(dms(h)[0]?.userId).toBe("UALICE");

    // Continuation parts are posted to the DM channel, threaded under the first message.
    const dmChannel = `DUALICE`;
    const threadParts = h.slack.posts.filter((p) => p.channel === dmChannel && p.thread_ts);
    expect(threadParts.length).toBeGreaterThan(0);
    // Nothing went to the PR channel.
    expect(channelReports(h)).toHaveLength(0);
  });

  it("shows in /nathan help", async () => {
    const h = prApp();
    const result = await send(h, commandBody("help"));
    expect(result.text).toContain("pr_report");
    expect(result.text).toContain("PR report");
  });
});
