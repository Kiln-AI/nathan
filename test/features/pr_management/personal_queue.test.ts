import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { prKey } from "../../../src/features/pr_management/metrics";
import {
  buildQueue,
  fitMessage,
  MAX_GROUP_ROWS,
  NO_OPEN_PRS_TEXT,
  NOTHING_OVERDUE_TEXT,
  NOTHING_WAITING_TEXT,
  parseTab,
  QUEUE_TABS,
  QUEUE_TRUNCATED_TEXT,
  type QueueTab,
  queueTabAction,
  relevantRecords,
  renderHome,
  renderQueueMessage,
  UNMAPPED_TEXT,
} from "../../../src/features/pr_management/personal_queue";
import { REFRESH_HOME_ACTION } from "../../../src/features/pr_management/request";
import type { PRRecord } from "../../../src/features/pr_management/store";
import { type HomeBlock, type MessageBlock, section } from "../../../src/slack";
import { aPR } from "../../builders/github";
import { aRecord } from "../../builders/pr_record";
import { type PRTestApp, prApp, REPO, testPeople } from "../../helpers/pr";
import { appHomeOpenedBody, blockActionBody, commandBody, signedSlackRequest } from "../../helpers/slack";

const at = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });
const NOW = at("2026-10-05T14:00:00Z");
const people = testPeople();
const hoursAgo = (hours: number) => NOW.minus({ hours });
const SERVER = "Kiln-AI/kiln_server";

/** Each block as one line of text: headers and context as is, list rows prefixed "• ", buttons in [brackets]. */
function lines(blocks: readonly (MessageBlock | HomeBlock)[]): string[] {
  return blocks.flatMap((block): string[] => {
    if (block.type === "header") return [`# ${block.text.text}`];
    if (block.type === "context") return block.elements.map((e) => ("text" in e ? e.text : ""));
    if (block.type === "section") return [block.text?.text ?? ""];
    if (block.type === "divider") return ["---"];
    if (block.type === "actions")
      return [block.elements.map((e) => ("text" in e && e.text ? `[${e.text.text}]` : "")).join(" ")];
    if (block.type === "rich_text") {
      return block.elements.flatMap((list) =>
        list.type === "rich_text_list"
          ? list.elements.map(
              (item) =>
                `• ${item.elements
                  .map((e) => {
                    if (e.type === "text") return e.style?.bold ? `*${e.text}*` : e.text;
                    if (e.type === "link") return `<${e.text}>`;
                    if (e.type === "user") return `@${e.user_id}`;
                    return "";
                  })
                  .join("")}`,
            )
          : [],
      );
    }
    return [];
  });
}

/** Owners past the threshold, keyed like `overdueOwners`. */
const overdueMap = (entries: [PRRecord, string[]][]) =>
  new Map(entries.map(([record, owners]) => [prKey(record), owners]));

// alice's view: two reviews (one overdue), her own CI failure, a draft, a PR overdue on bob, and noise.
const review3 = aRecord({
  number: 3,
  author: "bob",
  state: "awaiting_review",
  owners: ["ALICE"],
  stateSince: hoursAgo(54),
});
const review1 = aRecord({
  number: 1,
  repo: SERVER,
  author: "stranger",
  state: "awaiting_review",
  owners: ["alice", "carol"],
  stateSince: hoursAgo(5),
});
const ciFailing = aRecord({
  number: 4,
  author: "alice",
  state: "ci_failing",
  owners: ["alice"],
  stateSince: hoursAgo(2),
});
const draft = aRecord({ number: 5, author: "alice", state: "draft", owners: ["alice"], stateSince: hoursAgo(400) });
const onBob = aRecord({
  number: 7,
  author: "Alice",
  state: "awaiting_review",
  owners: ["bob"],
  reviewers: [{ login: "bob", status: "pending" }],
  stateSince: hoursAgo(30),
});
const notMine = aRecord({ number: 2, author: "carol", state: "approved", owners: ["carol"], stateSince: hoursAgo(50) });
const merged = aRecord({ number: 6, author: "alice", state: "merged", owners: [] });
const RECORDS = [review3, review1, ciFailing, draft, onBob, notMine, merged];
const OVERDUE = overdueMap([
  [review3, ["ALICE"]],
  [onBob, ["bob"]],
  [notMine, ["carol"]],
]);

const queueFor = (login: string, records: PRRecord[] = RECORDS, overdue = OVERDUE) =>
  buildQueue({ login, records, overdue, now: NOW });
const home = (tab: QueueTab, login = "alice", records = RECORDS, overdue = OVERDUE) =>
  lines(renderHome(queueFor(login, records, overdue), tab, people, login, NOW));

describe("buildQueue", () => {
  it("groups what's waiting on you by next step, longest waiting first, leaving out drafts", () => {
    const { waiting } = queueFor("alice");
    expect(waiting.map((g) => [g.title, g.items.map((i) => [i.record.number, i.overdue])])).toEqual([
      [
        "Review",
        [
          [3, true],
          [1, false],
        ],
      ],
      ["Fix CI", [[4, false]]],
    ]);
  });

  it("groups your open PRs by state, most action needed first, flagging ones overdue on others", () => {
    const { mine } = queueFor("alice");
    expect(mine.map((g) => [g.title, g.items.map((i) => [i.record.number, i.overdue])])).toEqual([
      ["❌ CI failing", [[4, false]]],
      ["👀 Awaiting review", [[7, true]]],
      ["📝 Draft", [[5, false]]],
    ]);
  });

  it("counts each overdue PR once: yours to act on, or yours waiting on someone else", () => {
    expect(queueFor("alice").stats).toEqual({
      waiting: {
        total: 3,
        byState: [
          { state: "awaiting_review", count: 2 },
          { state: "ci_failing", count: 1 },
        ],
      },
      mine: {
        total: 3,
        byState: [
          { state: "ci_failing", count: 1 },
          { state: "awaiting_review", count: 1 },
          { state: "draft", count: 1 },
        ],
      },
      overdue: { total: 2, waitingOnYou: 1, yoursOnOthers: 1, oldestHours: 54 },
    });
  });

  it("doesn't count your own overdue step as overdue on others", () => {
    const conflict = aRecord({
      number: 9,
      author: "alice",
      state: "conflict",
      owners: ["alice"],
      stateSince: hoursAgo(80),
    });
    const { stats } = queueFor("alice", [conflict], overdueMap([[conflict, ["alice"]]]));
    expect(stats.overdue).toEqual({ total: 1, waitingOnYou: 1, yoursOnOthers: 0, oldestHours: 80 });
  });

  it("keeps only the records a user owns or wrote", () => {
    expect(relevantRecords("alice", RECORDS).map((r) => r.number)).toEqual([3, 1, 4, 5, 7]);
  });
});

describe("renderHome", () => {
  it("golden file", async () => {
    const blocks = renderHome(queueFor("alice"), "all", people, "alice", NOW);
    await expect(`${JSON.stringify(blocks, null, 2)}\n`).toMatchFileSnapshot("__snapshots__/personal_queue.json");
  });

  it("leads with big-number stats, Overdue first", () => {
    expect(home("all").slice(0, 7)).toEqual([
      "# ⏰ 2 Overdue",
      "1 waiting on you · 1 of your PRs, waiting on others · oldest 2d 6h",
      "# 📥 3 Waiting on You",
      "2 reviews requested · 1 CI failing",
      "# 🚀 3 Open PRs",
      "❌ 1 CI failing · 👀 1 awaiting review · 📝 1 draft",
      "---",
    ]);
  });

  it("says so when nothing is overdue, waiting or open", () => {
    expect(home("all", "dan").slice(0, 6)).toEqual([
      "# ⏰ 0 Overdue",
      NOTHING_OVERDUE_TEXT,
      "# 📥 0 Waiting on You",
      NOTHING_WAITING_TEXT,
      "# 🚀 0 Open PRs",
      NO_OPEN_PRS_TEXT,
    ]);
  });

  it("shows tabs as secondary buttons with counts, ticking the current one", () => {
    const [tabs] = renderHome(queueFor("alice"), "overdue", people, "alice", NOW).filter((b) => b.type === "actions");
    expect(lines(tabs ? [tabs] : [])).toEqual([
      "[All] [✓ ⏰ Overdue · 2] [📥 Waiting on You · 3] [🚀 Your Open PRs · 3]",
    ]);
    const buttons = tabs?.type === "actions" ? tabs.elements : [];
    expect(buttons.map((b) => ("action_id" in b ? b.action_id : ""))).toEqual(QUEUE_TABS.map(queueTabAction));
    expect(buttons.map((b) => ("value" in b ? b.value : ""))).toEqual([...QUEUE_TABS]);
    expect(buttons.some((b) => "style" in b && b.style)).toBe(false);
  });

  it("lists both sections on All, with repo-named links, authors, waits and overdue flags", () => {
    const shown = home("all");
    expect(shown.slice(shown.indexOf("# 📥 Waiting on You"))).toEqual([
      "# 📥 Waiting on You",
      "3 PRs by next step, longest waiting first.",
      "Review · 2 · 1 overdue",
      "• <Kiln - #3> Add the thing · @UBOB · *⏰ 2d 6h*",
      "• <kiln_server - #1> Add the thing · stranger · 5h",
      "Fix CI · 1",
      "• <Kiln - #4> Add the thing · 2h",
      "---",
      "# 🚀 Your Open PRs",
      "3 open, most action needed first.",
      "❌ CI failing · 1",
      "• <Kiln - #4> Add the thing · 2h",
      "👀 Awaiting review · 1 · 1 overdue",
      "• <Kiln - #7> Add the thing · ⏳ @UBOB · *⏰ 1d 6h*",
      "📝 Draft · 1",
      "• <Kiln - #5> Add the thing · 2w 2d",
    ]);
  });

  it("filters both sections to overdue PRs on the Overdue tab", () => {
    const shown = home("overdue");
    expect(shown.slice(shown.indexOf("# 📥 Waiting on You"))).toEqual([
      "# 📥 Waiting on You",
      "1 overdue, by next step, longest waiting first.",
      "Review · 1",
      "• <Kiln - #3> Add the thing · @UBOB · *⏰ 2d 6h*",
      "---",
      "# 🚀 Your Open PRs",
      "1 overdue on someone else.",
      "👀 Awaiting review · 1",
      "• <Kiln - #7> Add the thing · ⏳ @UBOB · *⏰ 1d 6h*",
    ]);
    const none = home("overdue", "dan");
    expect(none.slice(none.indexOf("# 📥 Waiting on You"))).toEqual([
      "# 📥 Waiting on You",
      NOTHING_OVERDUE_TEXT,
      "---",
      "# 🚀 Your Open PRs",
      NOTHING_OVERDUE_TEXT,
    ]);
  });

  it("shows one section on its own tab", () => {
    const waiting = home("waiting");
    expect(waiting.filter((l) => l.startsWith("# ") && !/\d/.test(l))).toEqual(["# 📥 Waiting on You"]);
    const mine = home("mine");
    expect(mine.filter((l) => l.startsWith("# ") && !/\d/.test(l))).toEqual(["# 🚀 Your Open PRs"]);
  });

  it("lists every reviewer with their status, as on the card", () => {
    const reviewed = aRecord({
      number: 8,
      author: "alice",
      state: "changes_requested",
      owners: ["alice"],
      reviewers: [
        { login: "joe", status: "pending" },
        { login: "core", status: "pending", team: true },
        { login: "carol", status: "changes_requested" },
        { login: "bob", status: "approved" },
        { login: "outsider", status: "commented" },
      ],
    });
    expect(home("mine", "alice", [reviewed], new Map())).toContain(
      "• <Kiln - #8> Add the thing · ⏳ joe, ⏳ core (team), 🔁 @UCAROL, ✅ @UBOB, 💬 outsider · 3d 23h",
    );
  });

  it("names whoever else it waits on who isn't a reviewer, before the reviewers", () => {
    const onTriager = aRecord({
      number: 8,
      author: "alice",
      state: "ci_failing",
      owners: ["Dan", "alice"],
      reviewers: [{ login: "bob", status: "approved" }],
    });
    expect(home("mine", "alice", [onTriager], new Map())).toContain(
      "• <Kiln - #8> Add the thing · @UDAN, ✅ @UBOB · 3d 23h",
    );
  });

  it("names an owner who is also a reviewer once, with their status", () => {
    const two = aRecord({
      number: 8,
      author: "alice",
      state: "awaiting_review",
      owners: ["bob", "outsider"],
      reviewers: [
        { login: "Bob", status: "pending" },
        { login: "outsider", status: "pending" },
      ],
    });
    expect(home("mine", "alice", [two], new Map())).toContain(
      "• <Kiln - #8> Add the thing · ⏳ @UBOB, ⏳ outsider · 3d 23h",
    );
  });

  it("names an owner who has already reviewed once, by their review", () => {
    // An oss PR (alice wasn't mapped when it was refreshed) that dan, the triager, approved and now owns.
    const approvedByOwner = aRecord({
      number: 8,
      author: "alice",
      category: "oss",
      state: "approved",
      owners: ["Dan"],
      reviewers: [{ login: "dan", status: "approved" }],
    });
    expect(home("mine", "alice", [approvedByOwner], new Map())).toContain(
      "• <Kiln - #8> Add the thing · ✅ @UDAN · 3d 23h",
    );
  });

  it("names nobody when there are no reviewers and it's on you", () => {
    const yours = aRecord({ number: 8, author: "alice", state: "ci_failing", owners: ["alice"] });
    expect(home("mine", "alice", [yours], new Map())).toContain("• <Kiln - #8> Add the thing · 3d 23h");
  });

  it(`shows at most ${MAX_GROUP_ROWS} rows per group and counts the rest`, () => {
    const many = Array.from({ length: MAX_GROUP_ROWS + 2 }, (_, i) =>
      aRecord({ number: i + 1, author: "bob", state: "awaiting_review", owners: ["alice"], stateSince: hoursAgo(1) }),
    );
    const rows = home("waiting", "alice", many, new Map()).filter((l) => l.startsWith("• "));
    expect(rows).toHaveLength(MAX_GROUP_ROWS + 1);
    expect(rows.at(-1)).toBe("• …and 2 more");
  });
});

describe("renderQueueMessage", () => {
  it("is the All tab without tabs, with a one-line summary", () => {
    const message = renderQueueMessage(queueFor("alice"), people, "alice", NOW);
    expect(message.text).toBe("3 waiting on you, 2 overdue, 3 of yours open");
    expect(message.blocks.some((b) => b.type === "actions")).toBe(false);
    // The App Home's stats, divider, tabs, divider, lists; the message drops the tabs and one divider.
    const shown = home("all");
    expect(lines(message.blocks)).toEqual([...shown.slice(0, 7), ...shown.slice(9)]);
  });
});

describe("parseTab", () => {
  it("reads a known tab and falls back to All", () => {
    expect(parseTab("overdue")).toBe("overdue");
    expect(parseTab(undefined)).toBe("all");
    expect(parseTab("nonsense")).toBe("all");
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

    const shown = lines(h.slack.homes.at(-1)?.view.blocks ?? []);
    expect(shown[0]).toBe("[↻ Refresh · 10:00 AM] [Request PR]");
    expect(shown).toContain("# 📥 1 Waiting on You");
    expect(shown).toContain("# 🚀 1 Open PRs");
    expect(shown).toContain("[✓ All] [⏰ Overdue · 0] [📥 Waiting on You · 1] [🚀 Your Open PRs · 1]");
    expect(shown.join("\n")).toContain("<Kiln - #1>");
  });

  it("switches tabs from the App Home's buttons", async () => {
    const h = await withPRs();
    const click = blockActionBody(
      { action_id: queueTabAction("mine"), value: "mine" },
      { view: { callbackId: "", type: "home" } },
    );
    expect((await send(h, click)).status).toBe(200);

    const view = h.slack.homes.at(-1)?.view;
    expect(view?.private_metadata).toBe('{"pr_management":"mine"}');
    const shown = lines(view?.blocks ?? []);
    expect(shown[0]).toBe("[↻ Refresh · 10:00 AM] [Request PR]");
    expect(shown).toContain("[All] [⏰ Overdue · 0] [📥 Waiting on You · 1] [✓ 🚀 Your Open PRs · 1]");
    expect(shown).toContain("# 🚀 Your Open PRs");
    expect(shown).not.toContain("# 📥 Waiting on You");
  });

  it("counts and flags a PR once it passes the reminder threshold", async () => {
    const h = await withPRs(); // refreshed Monday 14:00 UTC
    h.clock.set("2026-10-06T16:00:00Z"); // 26 working hours later
    await send(h, appHomeOpenedBody("UALICE"), "application/json");

    const shown = lines(h.slack.homes.at(-1)?.view.blocks ?? []);
    expect(shown).toContain("# ⏰ 2 Overdue");
    expect(shown).toContain("1 waiting on you · 1 of your PRs, waiting on others · oldest 1d 2h");
    expect(shown).toContain("• <Kiln - #1> Add the thing · @UBOB · *⏰ 1d 2h*");
    expect(shown).toContain("• <Kiln - #2> Add the thing · ⏳ @UCAROL · *⏰ 1d 2h*");
  });

  it("still shows the queue when a stored reviewer list can't be read", async () => {
    const h = await withPRs();
    const setReviewers = (number: number, json: string) =>
      h.app.services.db.run("UPDATE pr_prs SET reviewers = ? WHERE repo = ? AND number = ?", json, REPO, number);
    await setReviewers(1, "{not json");
    await setReviewers(2, '[{"login":"carol","status":"snoozed"},{"login":"bob","status":"approved"}]');

    await send(h, appHomeOpenedBody("UALICE"), "application/json");

    const shown = lines(h.slack.homes.at(-1)?.view.blocks ?? []);
    expect(shown).toContain("# 📥 1 Waiting on You");
    expect(shown.find((line) => line.includes("<Kiln - #2>"))).toContain(" · @UCAROL, ✅ @UBOB · ");
  });

  it("refreshes from the App Home's Refresh button, keeping the tab", async () => {
    const h = await withPRs();
    const refresh = blockActionBody(
      { action_id: REFRESH_HOME_ACTION, value: "mine" },
      { view: { callbackId: "", type: "home", privateMetadata: '{"pr_management":"mine"}' } },
    );
    await send(h, refresh);

    const view = h.slack.homes.at(-1)?.view;
    expect(view?.private_metadata).toBe('{"pr_management":"mine"}');
    const shown = lines(view?.blocks ?? []);
    expect(shown[0]).toBe("[↻ Refresh · 10:00 AM] [Request PR]");
    expect(shown).toContain("[All] [⏰ Overdue · 0] [📥 Waiting on You · 1] [✓ 🚀 Your Open PRs · 1]");
    const refreshButton = view?.blocks
      .flatMap((b) => (b.type === "actions" ? b.elements : []))
      .find((e) => "action_id" in e && e.action_id === REFRESH_HOME_ACTION);
    expect(refreshButton).toMatchObject({ action_id: REFRESH_HOME_ACTION, value: "mine" });
  });

  it("shows an unmapped user how to get added, on the App Home and from /nathan prs", async () => {
    const h = prApp();
    await send(h, appHomeOpenedBody("USTRANGER"), "application/json");
    expect(lines(h.slack.homes.at(-1)?.view.blocks ?? [])).toContain(UNMAPPED_TEXT);
    await send(h, commandBody("prs").replace("UALICE", "USTRANGER"));
    expect(h.slack.responses[0]?.reply.text).toBe(UNMAPPED_TEXT);
  });

  it("answers /nathan prs with the same queue, as an ephemeral reply", async () => {
    const h = await withPRs();
    const response = await send(h, commandBody("prs"));

    expect(response.status).toBe(200);
    expect(h.slack.responses).toHaveLength(1);
    const reply = h.slack.responses[0]?.reply;
    expect(reply?.text).toBe("1 waiting on you, 0 overdue, 1 of yours open");
    expect(lines(reply?.blocks ?? [])).toContain("# 📥 1 Waiting on You");
    expect(lines(reply?.blocks ?? []).join("\n")).toContain("<Kiln - #1>");
  });
});
