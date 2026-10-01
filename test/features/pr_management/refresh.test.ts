import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import type { PRData } from "../../../src/github";
import { aPR, aReview } from "../../builders/github";
import { PR_CHANNEL, type PRTestApp, prApp, REPO } from "../../helpers/pr";

const awaitingBob = (overrides: Partial<PRData> = {}) => aPR({ pendingReviewers: ["bob"], ...overrides });

/** A PR with a live card, awaiting bob's review. Clears the recorded Slack calls. */
async function withCard(h: PRTestApp, overrides: Partial<PRData> = {}) {
  h.github.upsert(awaitingBob(overrides));
  expect(await h.refresh(101)).toEqual({ kind: "ack" });
  const card = (await h.record(101))?.card;
  if (!card) throw new Error("expected a card");
  h.slack.posts.length = 0;
  return card;
}

const blocksText = (blocks: unknown) => JSON.stringify(blocks);

describe("refresh: the record", () => {
  it("stores the status on first sight, then moves the staleness clock only on state or owner changes", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    await h.refresh(101);
    const first = await h.record(101);
    expect(first).toMatchObject({
      repo: REPO,
      number: 101,
      category: "team",
      state: "needs_reviewer",
      owners: ["alice"],
      card: null,
      version: 1,
    });
    expect(first?.stateSince).toEqual(h.clock.now());

    h.clock.advance({ hours: 1 });
    await h.refresh(101);
    const unchanged = await h.record(101);
    expect(unchanged?.stateSince).toEqual(first?.stateSince);
    expect(unchanged?.refreshedAt).toEqual(h.clock.now());

    h.clock.advance({ hours: 1 });
    h.github.upsert(aPR({ reviews: [aReview({ author: "bob", state: "commented" })] }));
    await h.refresh(101);
    expect(await h.record(101)).toMatchObject({ state: "needs_rerequest", stateSince: h.clock.now() });
  });

  it("resets the staleness clock when only the owners change", async () => {
    const h = prApp();
    await withCard(h);
    h.clock.advance({ hours: 3 });
    h.github.upsert(aPR({ pendingReviewers: ["carol"] }));
    await h.refresh(101);
    expect(await h.record(101)).toMatchObject({ owners: ["carol"], stateSince: h.clock.now() });
  });

  it("categorizes Dependabot and OSS PRs and gives author-side steps to the triager", async () => {
    const h = prApp();
    h.github.upsert(aPR({ number: 1, author: "dependabot[bot]", authorIsBot: true }));
    h.github.upsert(aPR({ number: 2, author: "outsider" }));
    await h.refresh(1);
    await h.refresh(2);
    expect(await h.record(1)).toMatchObject({ category: "dependabot", owners: ["dan"] });
    expect(await h.record(2)).toMatchObject({ category: "oss", owners: ["dan"] });
  });

  it("keeps the stored mergeability while GitHub reports unknown", async () => {
    const h = prApp();
    h.github.upsert(aPR({ mergeable: "conflicting" }));
    await h.refresh(101);
    h.github.upsert(aPR({ mergeable: "unknown" }));
    await h.refresh(101);
    expect(await h.record(101)).toMatchObject({ state: "conflict", mergeable: "conflicting" });
  });

  it("consumes the PR's events after a successful refresh, and keeps them after a failure", async () => {
    const h = prApp();
    const event = { event: "pull_request", action: "opened", actor: "alice", subject: null, receivedAt: h.clock.now() };
    await h.store.recordEvent(REPO, 101, event);
    h.github.fail();
    expect((await h.refresh(101)).kind).toBe("retry");
    expect(await h.events(101)).toHaveLength(1);

    h.github.succeed();
    h.github.upsert(aPR());
    await h.refresh(101);
    expect(await h.events(101)).toEqual([]);
  });
});

describe("refresh: data freshness", () => {
  it("leaves events received after the GitHub read for the refresh they scheduled, so their actor isn't lost", async () => {
    const h = prApp();
    await withCard(h);
    const read = h.github.reader.pullRequest;
    vi.spyOn(h.github.reader, "pullRequest").mockImplementationOnce(async (repo, number) => {
      const stale = await read(repo, number);
      // Alice removes bob while this refresh is reading GitHub.
      h.clock.advance({ seconds: 5 });
      h.github.upsert(aPR());
      await h.store.recordEvent(REPO, 101, {
        event: "pull_request",
        action: "review_request_removed",
        actor: "alice",
        subject: "bob",
        receivedAt: h.clock.now(),
      });
      return stale;
    });

    await h.refresh(101);
    expect(await h.events(101)).toHaveLength(1);

    await h.refresh(101);
    expect(await h.record(101)).toMatchObject({ state: "needs_reviewer" });
    expect(h.slack.posts).toEqual([]);
    expect(await h.events(101)).toEqual([]);
  });

  it("records when GitHub was read, not when the record was written", async () => {
    const h = prApp();
    const readAt = h.clock.now();
    const read = h.github.reader.pullRequest;
    vi.spyOn(h.github.reader, "pullRequest").mockImplementationOnce(async (repo, number) => {
      h.clock.advance({ minutes: 1 });
      return read(repo, number);
    });
    h.github.upsert(aPR());
    await h.refresh(101);
    expect(await h.record(101)).toMatchObject({ refreshedAt: readAt, stateSince: readAt });
  });

  it("doesn't write data older than the stored record's", async () => {
    const h = prApp();
    await withCard(h);
    const stale = awaitingBob();
    vi.spyOn(h.github.reader, "pullRequest").mockImplementationOnce(async () => {
      // A newer read (here, another refresh) lands while this one is in flight.
      h.github.upsert(aPR({ state: "merged" }));
      h.clock.advance({ seconds: 30 });
      await h.refresh(101);
      return stale;
    });

    await h.refresh(101);
    expect(await h.record(101)).toMatchObject({ state: "merged" });
    expect(h.slack.reactions).toHaveLength(1);
    expect(h.slack.posts).toEqual([]);
  });
});

describe("refresh: creating the card (GitHub-originated request)", () => {
  it.each<[string, Partial<PRData>, string]>([
    ["a person", { pendingReviewers: ["bob"] }, "Awaiting review"],
    // Team requests aren't expanded, so the state stays "needs a reviewer" (spec §4.2).
    ["a team", { pendingTeams: ["core"] }, "Needs a reviewer"],
  ])("posts one card when %s is requested", async (_name, overrides, label) => {
    const h = prApp();
    h.github.upsert(aPR(overrides));
    await h.refresh(101);
    expect(h.slack.posts).toHaveLength(1);
    expect(h.slack.posts[0]).toMatchObject({ channel: PR_CHANNEL, text: `Kiln-AI/Kiln#101 Add the thing: ${label}` });
    expect(h.slack.posts[0]?.thread_ts).toBeUndefined();
    const record = await h.record(101);
    expect(record?.card).toEqual({ channel: PR_CHANNEL, ts: "1000001.000100" });
    expect(record?.cardHash).toMatch(/^[0-9a-f]{64}$/);

    await h.refresh(101);
    expect(h.slack.posts).toHaveLength(1);
    expect(h.slack.updates).toEqual([]);
  });

  it.each<[string, Partial<PRData>]>([
    ["no reviewers are requested", {}],
    ["the PR is a draft", { isDraft: true, pendingReviewers: ["bob"] }],
    ["the PR is closed", { state: "closed", pendingReviewers: ["bob"] }],
  ])("posts nothing when %s", async (_name, overrides) => {
    const h = prApp();
    h.github.upsert(aPR(overrides));
    await h.refresh(101);
    expect(h.slack.posts).toEqual([]);
  });

  it("posts the card once when two refreshes race", async () => {
    const h = prApp();
    h.github.upsert(awaitingBob());
    await Promise.all([h.refresh(101), h.refresh(101), h.refresh(101)]);
    expect(h.slack.posts).toHaveLength(1);
  });

  it("leaves the card to whoever holds the lease, until it expires", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    await h.refresh(101);
    expect(await h.store.claimCard(REPO, 101, h.clock.now(), h.clock.now().minus({ minutes: 5 }))).toBe(true);

    h.github.upsert(awaitingBob());
    await h.refresh(101);
    expect(h.slack.posts).toEqual([]);

    h.clock.advance({ minutes: 6 });
    await h.refresh(101);
    expect(h.slack.posts).toHaveLength(1);
  });

  it("releases the lease when posting fails, so the retry posts it", async () => {
    const h = prApp();
    h.github.upsert(awaitingBob());
    h.slack.fail();
    expect((await h.refresh(101)).kind).toBe("retry");
    const row = await h.app.services.db.first<{ card_claimed_at: number | null }>(
      "SELECT card_claimed_at FROM pr_prs WHERE number = 101",
    );
    expect(row?.card_claimed_at).toBeNull();

    h.slack.succeed();
    await h.refresh(101);
    expect(h.slack.posts).toHaveLength(1);
  });
});

describe("refresh: keeping the card live", () => {
  it("edits the card in place and hands off to the new owner in its thread", async () => {
    const h = prApp();
    const card = await withCard(h);
    h.github.upsert(aPR({ reviews: [aReview({ author: "bob", state: "approved" })] }));
    await h.refresh(101);

    expect(h.slack.updates).toHaveLength(1);
    expect(h.slack.updates[0]).toMatchObject({ ...card, text: "Kiln-AI/Kiln#101 Add the thing: Approved" });
    expect(h.slack.posts).toEqual([
      { channel: card.channel, thread_ts: card.ts, text: "<@UALICE> — bob approved ✅. Ready to merge." },
    ]);
  });

  it("doesn't touch Slack when nothing visible changed", async () => {
    const h = prApp();
    await withCard(h);
    await h.refresh(101);
    expect(h.slack.updates).toEqual([]);
    expect(h.slack.posts).toEqual([]);
  });

  it("updates the age shown on the card as time passes, without a handoff", async () => {
    const h = prApp();
    await withCard(h);
    h.clock.advance({ hours: 2 });
    await h.refresh(101);
    expect(h.slack.updates).toHaveLength(1);
    expect(h.slack.posts).toEqual([]);
  });

  it("shows a draft on the card but posts no handoff", async () => {
    const h = prApp();
    await withCard(h);
    h.github.upsert(aPR({ isDraft: true, pendingReviewers: ["bob"] }));
    await h.refresh(101);
    expect(blocksText(h.slack.updates[0]?.blocks)).toContain("📝 *Draft*");
    expect(h.slack.posts).toEqual([]);
  });

  it.each<[string, Partial<PRData>, string, string]>([
    ["merged", { state: "merged" }, "🟣 *Merged*", "large_purple_circle"],
    ["closed", { state: "closed" }, "⚫ *Closed*", "black_circle"],
  ])("finalizes a %s PR with one reaction and no thread reply", async (_name, overrides, heading, reaction) => {
    const h = prApp();
    const card = await withCard(h);
    h.github.upsert(aPR(overrides));
    await h.refresh(101);
    await h.refresh(101);

    expect(blocksText(h.slack.updates[0]?.blocks)).toContain(heading);
    expect(h.slack.reactions).toEqual([{ ...card, name: reaction }]);
    expect(h.slack.posts).toEqual([]);
    expect(await h.record(101)).toMatchObject({ owners: [] });
  });

  it("brings a reopened PR's card back to life", async () => {
    const h = prApp();
    await withCard(h);
    h.github.upsert(aPR({ state: "closed" }));
    await h.refresh(101);
    h.github.upsert(awaitingBob());
    await h.refresh(101);

    expect(blocksText(h.slack.updates.at(-1)?.blocks)).toContain("👀 *Awaiting review*");
    expect(h.slack.reactions).toHaveLength(1);
    expect(h.slack.posts.map((p) => p.text)).toEqual(["<@UBOB> — Your review is requested 👀."]);
  });

  it("posts no handoff for a PR without a card", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    await h.refresh(101);
    h.github.upsert(aPR({ reviews: [aReview({ author: "bob", state: "approved" })] }));
    await h.refresh(101);
    expect(h.slack.posts).toEqual([]);
    expect(await h.record(101)).toMatchObject({ state: "approved" });
  });

  it("restores the old status when the handoff fails, so the retry posts it exactly once", async () => {
    const h = prApp();
    await withCard(h);
    h.github.upsert(aPR({ reviews: [aReview({ author: "bob", state: "approved" })] }));
    vi.spyOn(h.slack, "postMessage").mockRejectedValueOnce(new Error("slack is down"));

    expect((await h.refresh(101)).kind).toBe("retry");
    expect(await h.record(101)).toMatchObject({ state: "awaiting_review", owners: ["bob"] });
    expect(h.slack.updates).toHaveLength(1);

    await h.refresh(101);
    expect(h.slack.posts.map((p) => p.text)).toEqual(["<@UALICE> — bob approved ✅. Ready to merge."]);
    expect(h.slack.updates).toHaveLength(1);
    expect(await h.record(101)).toMatchObject({ state: "approved" });
  });
});

describe("refresh: vanished PRs", () => {
  it("finalizes a tracked PR GitHub no longer has as closed, rendering the card from the record", async () => {
    const h = prApp();
    const card = await withCard(h, { pendingReviewers: ["bob"], additions: 7 });
    h.github.prs.length = 0;
    await h.refresh(101);

    expect(await h.record(101)).toMatchObject({ state: "closed", owners: [] });
    const blocks = blocksText(h.slack.updates[0]?.blocks);
    expect(blocks).toContain("⚫ *Closed*");
    expect(blocks).toContain("+7 −2");
    expect(blocks).not.toContain("Reviewers");
    expect(h.slack.reactions).toEqual([{ ...card, name: "black_circle" }]);

    await h.refresh(101);
    expect(h.slack.updates).toHaveLength(1);
  });

  it("does nothing for a PR it never stored", async () => {
    const h = prApp();
    await h.store.recordEvent(REPO, 5, {
      event: "pull_request",
      action: "closed",
      actor: "alice",
      subject: null,
      receivedAt: h.clock.now(),
    });
    expect(await h.refresh(5)).toEqual({ kind: "ack" });
    expect(await h.record(5)).toBeNull();
    expect(await h.events(5)).toEqual([]);
  });
});

describe("refresh: concurrent writers", () => {
  /** Makes another writer bump the record's version just before each of the next `times` status writes. */
  function interfere(h: PRTestApp, times: number) {
    const { db } = h.app.services;
    const run = db.run.bind(db);
    let remaining = times;
    vi.spyOn(db, "run").mockImplementation(async (sql, ...params) => {
      if (remaining > 0 && sql.includes("UPDATE pr_prs SET title")) {
        remaining -= 1;
        await run("UPDATE pr_prs SET version = version + 1 WHERE number = 101");
      }
      return run(sql, ...params);
    });
  }

  it("recomputes from the fresh record after losing a compare-and-set", async () => {
    const h = prApp();
    await withCard(h);
    h.github.upsert(aPR({ reviews: [aReview({ author: "bob", state: "approved" })] }));
    interfere(h, 1);
    expect(await h.refresh(101)).toEqual({ kind: "ack" });
    expect(await h.record(101)).toMatchObject({ state: "approved", version: 3 });
    expect(h.slack.posts).toHaveLength(1);
  });

  it("gives up (and retries the job) when it keeps losing", async () => {
    const h = prApp();
    await withCard(h);
    interfere(h, 3);
    expect((await h.refresh(101)).kind).toBe("retry");
    expect(h.log.at("warn").map((e) => e.fields.error)).toContainEqual(
      expect.objectContaining({ message: "Gave up refreshing Kiln-AI/Kiln#101: other refreshes kept writing it" }),
    );
  });
});

describe("refresh job", () => {
  it("ignores PRs in repos that are no longer tracked", async () => {
    const h = prApp();
    h.github.upsert(awaitingBob({ repo: "Kiln-AI/old" }));
    expect(await h.runJob("refresh", { repo: "Kiln-AI/old", number: 101 })).toEqual({ kind: "ack" });
    expect(await h.record(101, "Kiln-AI/old")).toBeNull();
  });

  it("uses the configured spelling of the repo", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    await h.runJob("refresh", { repo: "kiln-ai/kiln", number: 101 });
    expect(await h.record(101)).not.toBeNull();
  });

  it("stores times in UTC", async () => {
    const h = prApp();
    h.github.upsert(aPR({ createdAt: DateTime.fromISO("2026-10-01T11:00:00-04:00") }));
    await h.refresh(101);
    expect((await h.record(101))?.createdAt.toISO()).toBe("2026-10-01T15:00:00.000Z");
  });
});
