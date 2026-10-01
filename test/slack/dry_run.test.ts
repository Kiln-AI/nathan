import { describe, expect, it } from "vitest";
import {
  actions,
  button,
  context,
  divider,
  header,
  MAX_MESSAGE_BLOCKS,
  type MessageBlock,
  modal,
  section,
} from "../../src/slack";
import { createDryRunSlackClient, defuseMentions } from "../../src/slack/dry_run";
import { FakeSlack } from "../fakes/slack";

const names: Record<string, string> = { UALICE: "alice" };
const nameOf = (id: string) => names[id];

function dryRun() {
  const inner = new FakeSlack();
  return { inner, client: createDryRunSlackClient(inner, { testChannel: "CTEST", nameOf }) };
}

describe("defuseMentions", () => {
  it.each([
    ["<@UALICE> please review", "@alice please review"],
    ["<@UBOB|bobby> and <@WEXT>", "@bobby and @WEXT"],
    ["<!here> <!channel|channel> <!everyone>", "@here @channel @everyone"],
    ["<!subteam^S123|@devs> and <!subteam^S456>", "@devs and @S456"],
    ["<#CPRS> and <https://x.test|a link>", "<#CPRS> and <https://x.test|a link>"],
  ])("%j → %j", (input, expected) => {
    expect(defuseMentions(input, nameOf)).toBe(expected);
  });
});

describe("createDryRunSlackClient", () => {
  it("posts to the test channel with a label, keeping the thread", async () => {
    const { inner, client } = dryRun();
    const posted = await client.postMessage({ channel: "CPRS", text: "<@UALICE> review", thread_ts: "9.9" });
    expect(posted.channel).toBe("CTEST");
    expect(inner.posts).toEqual([
      { channel: "CTEST", text: "[dry-run → <#CPRS>] @alice review", blocks: undefined, thread_ts: "9.9" },
    ]);
  });

  it("prepends a label block and defuses mentions anywhere in the blocks", async () => {
    const { inner, client } = dryRun();
    await client.postMessage({
      channel: "CPRS",
      text: "card",
      blocks: [section("Owner: <@UALICE>", { fields: ["<!here>"] }), actions([button({ text: "Go", actionId: "go" })])],
    });
    expect(inner.posts[0]?.blocks).toEqual([
      context("[dry-run → <#CPRS>]"),
      section("Owner: @alice", { fields: ["@here"] }),
      actions([button({ text: "Go", actionId: "go" })]),
    ]);
  });

  describe("a message already at Slack's 50-block limit", () => {
    const filler = Array.from({ length: MAX_MESSAGE_BLOCKS - 1 }, () => divider());
    const post = async (first: MessageBlock) => {
      const { inner, client } = dryRun();
      await client.postMessage({ channel: "CPRS", text: "report", blocks: [first, ...filler] });
      const blocks = inner.posts[0]?.blocks ?? [];
      expect(blocks).toHaveLength(MAX_MESSAGE_BLOCKS);
      return blocks[0];
    };

    it("folds the label into a leading section", async () => {
      expect(await post(section("Daily report"))).toEqual(section("[dry-run → <#CPRS>]\nDaily report"));
    });

    it("folds the label into a leading context block", async () => {
      expect(await post(context("as of today"))).toEqual(context("[dry-run → <#CPRS>]", "as of today"));
    });

    it("leaves other blocks alone, keeping the label in the text", async () => {
      expect(await post(header("Report"))).toEqual(header("Report"));
    });
  });

  it("redirects updates and reactions to the test channel", async () => {
    const { inner, client } = dryRun();
    await client.updateMessage({ channel: "CPRS", ts: "1.1", text: "<@UALICE> merged" });
    await client.addReaction({ channel: "CPRS", ts: "1.1", name: "tada" });
    expect(inner.updates).toEqual([
      { channel: "CTEST", ts: "1.1", text: "[dry-run → <#CPRS>] @alice merged", blocks: undefined },
    ]);
    expect(inner.reactions).toEqual([{ channel: "CTEST", ts: "1.1", name: "tada" }]);
  });

  it("turns direct messages into test-channel posts naming the recipient", async () => {
    const { inner, client } = dryRun();
    await client.sendDirectMessage("UALICE", { text: "your draft is old" });
    await client.sendDirectMessage("UNOBODY", { text: "hi" });
    expect(inner.dms).toEqual([]);
    expect(inner.posts.map((p) => [p.channel, p.text])).toEqual([
      ["CTEST", "[dry-run → DM @alice] your draft is old"],
      ["CTEST", "[dry-run → DM @UNOBODY] hi"],
    ]);
  });

  it("passes views, ephemeral replies and reads through unchanged", async () => {
    const { inner, client } = dryRun();
    inner.timeZones.set("UALICE", "Asia/Shanghai");
    const view = modal({ callbackId: "form", title: "Form", blocks: [] });
    const home = { type: "home" as const, blocks: [section("<@UALICE>")] };

    expect(await client.openView("trig", view)).toEqual({ viewId: "V1", hash: "hash-1" });
    await client.updateView({ viewId: "V1", view });
    await client.publishHome("UALICE", home);
    await client.respond("https://hooks.slack.test/r", { text: "<@UALICE>" });

    expect(inner.openedViews).toEqual([{ triggerId: "trig", view }]);
    expect(inner.updatedViews).toEqual([{ viewId: "V1", view }]);
    expect(inner.homes).toEqual([{ userId: "UALICE", view: home }]);
    expect(inner.responses).toEqual([{ responseUrl: "https://hooks.slack.test/r", reply: { text: "<@UALICE>" } }]);
    expect(await client.userTimeZone("UALICE")).toBe("Asia/Shanghai");
    expect(await client.authTest()).toEqual(await inner.authTest());
  });
});
