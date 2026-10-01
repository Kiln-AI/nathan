import { describe, expect, it } from "vitest";
import { helpText, parseCommandText, unknownCommandText } from "../../src/slack/commands";

describe("parseCommandText", () => {
  it.each([
    ["", { subcommand: "", args: "" }],
    ["   ", { subcommand: "", args: "" }],
    ["PRS", { subcommand: "prs", args: "" }],
    ["  prs   alice  bob ", { subcommand: "prs", args: "alice  bob" }],
    ["prs\tnow", { subcommand: "prs", args: "now" }],
  ])("%j", (text, expected) => {
    expect(parseCommandText(text)).toEqual(expected);
  });
});

describe("helpText", () => {
  it("lists help and every subcommand alphabetically, with usage", () => {
    const text = helpText("/nathan", [
      { name: "prs", description: "Your PR queue" },
      { name: "about", description: "What Nathan is", usage: "[topic]" },
    ]);
    expect(text).toBe(
      [
        "*What I can do* (`/nathan <command>`):",
        "• `/nathan about [topic]` — What Nathan is",
        "• `/nathan help` — Show this list",
        "• `/nathan prs` — Your PR queue",
      ].join("\n"),
    );
  });

  it("explains an unknown subcommand before the help", () => {
    expect(unknownCommandText("/nathan-staging", "nope", [])).toBe(
      "I don't know `/nathan-staging nope`.\n\n*What I can do* (`/nathan-staging <command>`):\n• `/nathan-staging help` — Show this list",
    );
  });
});
