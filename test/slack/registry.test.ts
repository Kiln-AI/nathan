import { describe, expect, it } from "vitest";
import { SlackHandlers } from "../../src/slack/registry";

const noop = async () => {};

describe("SlackHandlers", () => {
  it("records registrations with their feature", () => {
    const handlers = new SlackHandlers();
    const alpha = handlers.forFeature("alpha");
    const shortcut = { ack: noop };
    alpha.shortcut("request_pr", shortcut);
    alpha.homeSection({ order: 1, render: async () => [] });
    expect(handlers.shortcuts.get("request_pr")).toEqual({ featureId: "alpha", handler: shortcut });
    expect(handlers.homeSections.map((s) => s.featureId)).toEqual(["alpha"]);
  });

  it.each([
    ["shortcut", (r: ReturnType<SlackHandlers["forFeature"]>) => r.shortcut("x", { ack: noop })],
    ["view submission", (r: ReturnType<SlackHandlers["forFeature"]>) => r.viewSubmission("x", { ack: noop })],
    ["action", (r: ReturnType<SlackHandlers["forFeature"]>) => r.action("x", {})],
    ["subcommand", (r: ReturnType<SlackHandlers["forFeature"]>) => r.command("x", { description: "d" })],
  ])("rejects a duplicate %s, including across features", (kind, register) => {
    const handlers = new SlackHandlers();
    register(handlers.forFeature("alpha"));
    expect(() => register(handlers.forFeature("beta"))).toThrow(`Slack ${kind} "x" is already registered by alpha`);
  });

  it.each(["Prs", "my_cmd", "-x", ""])("rejects the subcommand name %j", (name) => {
    expect(() => new SlackHandlers().forFeature("alpha").command(name, { description: "d" })).toThrow(
      "must be lowercase letters, digits and -",
    );
  });

  it("reserves help", () => {
    expect(() => new SlackHandlers().forFeature("alpha").command("help", { description: "d" })).toThrow(
      'Subcommand "help" is built in',
    );
  });
});
