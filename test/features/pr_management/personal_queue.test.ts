import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  fitMessage,
  NO_OPEN_PRS_TEXT,
  NOTHING_WAITING_TEXT,
  personalQueue,
  QUEUE_TRUNCATED_TEXT,
  UNMAPPED_TEXT,
} from "../../../src/features/pr_management/personal_queue";
import { HOME_TEXT } from "../../../src/features/pr_management/request";
import { type MessageBlock, section } from "../../../src/slack";
import { aPR } from "../../builders/github";
import { aRecord } from "../../builders/pr_record";
import { type PRTestApp, prApp, REPO, testPeople } from "../../helpers/pr";
import { appHomeOpenedBody, commandBody, signedSlackRequest } from "../../helpers/slack";

const at = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });
const NOW = at("2026-10-05T14:00:00Z");
const people = testPeople();
const hoursAgo = (hours: number) => NOW.minus({ hours });

/** The queue's mrkdwn lines. */
function lines(blocks: readonly MessageBlock[]): string[] {
  return blocks.flatMap((block) => (block.type === "section" && block.text ? block.text.text.split("\n") : []));
}

const queueFor = (login: string | null, records = [] as ReturnType<typeof aRecord>[]) =>
  personalQueue({ login, records, now: NOW, people });

describe("personalQueue", () => {
  const records = [
    aRecord({
      number: 1,
      author: "bob",
      state: "awaiting_review",
      owners: ["alice", "carol"],
      stateSince: hoursAgo(5),
    }),
    aRecord({ number: 2, author: "carol", state: "approved", owners: ["carol"], stateSince: hoursAgo(50) }),
    aRecord({ number: 3, author: "bob", state: "awaiting_review", owners: ["ALICE"], stateSince: hoursAgo(30) }),
    aRecord({ number: 4, author: "alice", state: "ci_failing", owners: ["alice"], stateSince: hoursAgo(2) }),
    aRecord({ number: 5, author: "alice", state: "draft", owners: ["alice"], createdAt: hoursAgo(400) }),
    aRecord({ number: 6, author: "alice", state: "merged", owners: [] }),
    aRecord({ number: 7, author: "Alice", state: "awaiting_review", owners: ["bob"], createdAt: hoursAgo(10) }),
  ];

  it("golden file", async () => {
    await expect(`${JSON.stringify(queueFor("alice", records), null, 2)}\n`).toMatchFileSnapshot(
      "__snapshots__/personal_queue.json",
    );
  });

  it("groups what's waiting on you by next step, longest-waiting first, leaving out drafts", () => {
    const shown = lines(queueFor("alice", records).blocks);
    expect(shown.slice(0, 6)).toEqual([
      "*Waiting on you* (3)",
      "*Review*",
      "• <https://github.com/Kiln-AI/Kiln/pull/3|Kiln-AI/Kiln#3> Add the thing · by bob · waiting 1d 6h",
      "• <https://github.com/Kiln-AI/Kiln/pull/1|Kiln-AI/Kiln#1> Add the thing · by bob · waiting 5h",
      "*Fix CI*",
      "• <https://github.com/Kiln-AI/Kiln/pull/4|Kiln-AI/Kiln#4> Add the thing · by alice · waiting 2h",
    ]);
  });

  it("lists your open PRs oldest first, with state and owners, leaving out merged and closed ones", () => {
    const shown = lines(queueFor("alice", records).blocks);
    expect(shown.slice(shown.indexOf("*Your open PRs* (3)") + 1)).toEqual([
      "• <https://github.com/Kiln-AI/Kiln/pull/5|Kiln-AI/Kiln#5> Add the thing · 📝 Draft · Owner: <@UALICE> · opened 2w 2d ago",
      "• <https://github.com/Kiln-AI/Kiln/pull/4|Kiln-AI/Kiln#4> Add the thing · ❌ CI failing · Owner: <@UALICE> · opened 3d 23h ago",
      "• <https://github.com/Kiln-AI/Kiln/pull/7|Kiln-AI/Kiln#7> Add the thing · 👀 Awaiting review · Owner: <@UBOB> · opened 10h ago",
    ]);
  });

  it("names several owners, and says so when nothing is waiting or open", () => {
    const shown = lines(queueFor("bob", records).blocks);
    expect(shown).toContain(
      "• <https://github.com/Kiln-AI/Kiln/pull/1|Kiln-AI/Kiln#1> Add the thing · 👀 Awaiting review · Owners: <@UALICE>, <@UCAROL> · opened 3d 23h ago",
    );
    const empty = queueFor("dan", records);
    expect(lines(empty.blocks)).toEqual([
      "*Waiting on you*",
      NOTHING_WAITING_TEXT,
      "*Your open PRs*",
      NO_OPEN_PRS_TEXT,
    ]);
    expect(empty.text).toBe("0 waiting on you, 0 of yours open");
  });

  it("shows your PR in the merge queue with no owner, and waiting on nobody", () => {
    const queued = aRecord({ number: 8, author: "alice", state: "in_merge_queue", owners: [], createdAt: hoursAgo(3) });
    const shown = lines(queueFor("alice", [queued]).blocks);
    expect(shown).toEqual([
      "*Waiting on you*",
      NOTHING_WAITING_TEXT,
      "*Your open PRs* (1)",
      "• <https://github.com/Kiln-AI/Kiln/pull/8|Kiln-AI/Kiln#8> Add the thing · 🚂 In merge queue · opened 3h ago",
    ]);
  });

  it("tells an unmapped user how to get added", () => {
    expect(queueFor(null, records)).toEqual({ text: UNMAPPED_TEXT, blocks: [section(UNMAPPED_TEXT)] });
  });
});

describe("fitMessage", () => {
  it("keeps a message within 50 blocks, saying some are hidden", () => {
    const blocks = Array.from({ length: 60 }, (_, i) => section(`s${i}`));
    const fitted = fitMessage(blocks);
    expect(fitted).toHaveLength(50);
    expect(fitted.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: QUEUE_TRUNCATED_TEXT }] });
    expect(fitMessage(blocks.slice(0, 50))).toEqual(blocks.slice(0, 50));
  });
});

async function send(h: PRTestApp, body: string, contentType?: string) {
  const ctx = createExecutionContext();
  const response = await h.app.fetch(await signedSlackRequest(body, { contentType }), ctx);
  await response.text();
  await waitOnExecutionContext(ctx);
  return response;
}

describe("App Home and /nathan prs", () => {
  async function withPRs() {
    const h = prApp();
    h.github.upsert(aPR({ number: 1, author: "bob", pendingReviewers: ["alice"] }));
    h.github.upsert(aPR({ number: 2, author: "alice", pendingReviewers: ["carol"] }));
    await h.refresh(1);
    await h.refresh(2);
    return h;
  }

  it("shows the queue on the App Home, after the Request PR section", async () => {
    const h = await withPRs();
    await send(h, appHomeOpenedBody("UALICE"), "application/json");

    const view = h.slack.homes.at(-1)?.view;
    const shown = lines((view?.blocks ?? []) as MessageBlock[]);
    expect(shown[0]).toBe(HOME_TEXT);
    expect(shown).toContain("*Waiting on you* (1)");
    expect(shown).toContain("*Your open PRs* (1)");
    expect(shown.join("\n")).toContain(`${REPO}#1`);
  });

  it("answers /nathan prs with the same queue, as an ephemeral reply", async () => {
    const h = await withPRs();
    const response = await send(h, commandBody("prs"));

    expect(response.status).toBe(200);
    expect(h.slack.responses).toHaveLength(1);
    const reply = h.slack.responses[0]?.reply;
    expect(reply?.text).toBe("1 waiting on you, 1 of yours open");
    expect(lines(reply?.blocks ?? [])).toContain("*Waiting on you* (1)");
  });

  it("answers an unmapped user with how to get added", async () => {
    const h = prApp();
    await send(h, commandBody("prs").replace("UALICE", "USTRANGER"));
    expect(h.slack.responses[0]?.reply.text).toBe(UNMAPPED_TEXT);
  });
});
