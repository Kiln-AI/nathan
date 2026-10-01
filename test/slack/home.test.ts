import { describe, expect, it } from "vitest";
import { context, divider, type HomeSection, section } from "../../src/slack";
import { composeHome, EMPTY_HOME_TEXT, SECTION_FAILED_TEXT, TRUNCATED_TEXT } from "../../src/slack/home";
import type { Registered } from "../../src/slack/registry";

const sectionOf = (featureId: string, order: number, render: HomeSection["render"]): Registered<HomeSection> => ({
  featureId,
  handler: { order, render },
});
const showing = (featureId: string, order: number, ...texts: string[]) =>
  sectionOf(featureId, order, async () => texts.map((t) => section(t)));

const noReports = async () => {
  throw new Error("unexpected report");
};

describe("composeHome", () => {
  it("orders sections by `order`, keeps registration order for ties, and separates them", async () => {
    const view = await composeHome(
      [showing("b", 2, "B"), showing("a1", 1, "A1"), showing("a2", 1, "A2")],
      "U1",
      noReports,
    );
    expect(view).toEqual({
      type: "home",
      blocks: [section("A1"), divider(), section("A2"), divider(), section("B")],
    });
  });

  it("passes the viewing user to each section and skips empty ones", async () => {
    const seen: string[] = [];
    const view = await composeHome(
      [
        sectionOf("a", 1, async ({ userId }) => {
          seen.push(userId);
          return [];
        }),
        showing("b", 2, "B"),
      ],
      "UBOB",
      noReports,
    );
    expect(seen).toEqual(["UBOB"]);
    expect(view.blocks).toEqual([section("B")]);
  });

  it("replaces a failing section with a notice and reports it", async () => {
    const reports: [string, unknown][] = [];
    const failure = new Error("db down");
    const view = await composeHome(
      [
        sectionOf("broken", 1, async () => {
          throw failure;
        }),
        showing("ok", 2, "fine"),
      ],
      "U1",
      async (featureId, error) => {
        reports.push([featureId, error]);
      },
    );
    expect(view.blocks).toEqual([context(SECTION_FAILED_TEXT), divider(), section("fine")]);
    expect(reports).toEqual([["broken", failure]]);
  });

  it("shows a placeholder when there is nothing to show", async () => {
    expect((await composeHome([], "U1", noReports)).blocks).toEqual([section(EMPTY_HOME_TEXT)]);
  });

  it("doesn't leave a divider right before the truncation note", async () => {
    const first = Array.from({ length: 98 }, (_, i) => `a${i}`);
    const { blocks } = await composeHome([showing("a", 1, ...first), showing("b", 2, "b0", "b1")], "U1", noReports);
    expect(blocks).toHaveLength(99);
    expect(blocks.at(-2)).toEqual(section("a97"));
    expect(blocks.at(-1)).toEqual(context(TRUNCATED_TEXT));
  });

  it("truncates to Slack's 100-block limit with a note", async () => {
    const many = Array.from({ length: 120 }, (_, i) => `row ${i}`);
    const { blocks } = await composeHome([showing("a", 1, ...many)], "U1", noReports);
    expect(blocks).toHaveLength(100);
    expect(blocks[98]).toEqual(section("row 98"));
    expect(blocks[99]).toEqual(context(TRUNCATED_TEXT));
  });
});
