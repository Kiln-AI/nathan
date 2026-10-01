import { describe, expect, it } from "vitest";
import {
  actions,
  button,
  channelLink,
  checkboxes,
  context,
  divider,
  escapeText,
  header,
  homeView,
  input,
  link,
  MAX_SECTION_TEXT,
  mention,
  modal,
  multiUsersSelect,
  section,
  textInput,
  truncate,
  urlInput,
} from "../../src/slack";

describe("text helpers", () => {
  it("escapes mrkdwn control characters", () => {
    expect(escapeText("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("formats links, mentions and channel links", () => {
    expect(link("https://github.com/o/r/pull/1", "Fix <thing>")).toBe(
      "<https://github.com/o/r/pull/1|Fix &lt;thing&gt;>",
    );
    expect(mention("U1")).toBe("<@U1>");
    expect(channelLink("C1")).toBe("<#C1>");
  });

  it("truncates with an ellipsis only when needed", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcd", 3)).toBe("ab…");
  });

  it("never splits an emoji when truncating", () => {
    expect(truncate("ab🎉cd", 4)).toBe("ab…");
    expect(truncate("ab🎉cd", 5)).toBe("ab🎉…");
  });
});

describe("blocks", () => {
  it("builds sections with optional fields, accessory and block id", () => {
    expect(section("hi")).toEqual({ type: "section", text: { type: "mrkdwn", text: "hi" } });
    const go = button({ text: "Go", actionId: "go" });
    expect(section("hi", { fields: ["a", "b"], accessory: go, blockId: "s1" })).toEqual({
      type: "section",
      block_id: "s1",
      text: { type: "mrkdwn", text: "hi" },
      fields: [
        { type: "mrkdwn", text: "a" },
        { type: "mrkdwn", text: "b" },
      ],
      accessory: go,
    });
  });

  it("truncates section text to Slack's limit", () => {
    const text = section("x".repeat(MAX_SECTION_TEXT + 10)).text?.text ?? "";
    expect(text).toHaveLength(MAX_SECTION_TEXT);
    expect(text.endsWith("…")).toBe(true);
  });

  it("caps headers at 150 characters and context blocks at 10 elements", () => {
    expect(header("h".repeat(200)).text.text).toHaveLength(150);
    expect(context(...Array.from({ length: 12 }, (_, i) => `c${i}`)).elements).toHaveLength(10);
  });

  it("builds dividers and action rows", () => {
    expect(divider()).toEqual({ type: "divider" });
    const go = button({ text: "Go", actionId: "go" });
    expect(actions([go])).toEqual({ type: "actions", elements: [go] });
    expect(actions([go], "row")).toEqual({ type: "actions", block_id: "row", elements: [go] });
  });

  it("builds inputs with optional flags", () => {
    const element = urlInput({ actionId: "url" });
    expect(input({ blockId: "pr", label: "PR link", element })).toEqual({
      type: "input",
      block_id: "pr",
      label: { type: "plain_text", text: "PR link", emoji: true },
      element,
    });
    expect(
      input({ blockId: "pr", label: "PR", element, optional: true, hint: "Paste it", dispatchAction: true }),
    ).toEqual({
      type: "input",
      block_id: "pr",
      label: { type: "plain_text", text: "PR", emoji: true },
      element,
      optional: true,
      hint: { type: "plain_text", text: "Paste it", emoji: true },
      dispatch_action: true,
    });
  });
});

describe("elements", () => {
  it("builds buttons with optional value, url and style", () => {
    expect(button({ text: "Go", actionId: "go" })).toEqual({
      type: "button",
      action_id: "go",
      text: { type: "plain_text", text: "Go", emoji: true },
    });
    expect(button({ text: "Go", actionId: "go", value: "", url: "https://x.test", style: "primary" })).toMatchObject({
      value: "",
      url: "https://x.test",
      style: "primary",
    });
  });

  it("builds inputs with placeholders and initial values", () => {
    expect(urlInput({ actionId: "u", placeholder: "https://…", initialValue: "https://a" })).toEqual({
      type: "url_text_input",
      action_id: "u",
      placeholder: { type: "plain_text", text: "https://…", emoji: true },
      initial_value: "https://a",
    });
    expect(textInput({ actionId: "t" })).toEqual({ type: "plain_text_input", action_id: "t" });
    expect(textInput({ actionId: "t", multiline: true, placeholder: "p", initialValue: "v", maxLength: 500 })).toEqual({
      type: "plain_text_input",
      action_id: "t",
      multiline: true,
      placeholder: { type: "plain_text", text: "p", emoji: true },
      initial_value: "v",
      max_length: 500,
    });
    expect(multiUsersSelect({ actionId: "m" })).toEqual({ type: "multi_users_select", action_id: "m" });
    expect(multiUsersSelect({ actionId: "m", placeholder: "Who?", initialUsers: ["U1"] })).toEqual({
      type: "multi_users_select",
      action_id: "m",
      placeholder: { type: "plain_text", text: "Who?", emoji: true },
      initial_users: ["U1"],
    });
  });

  it("builds checkboxes with descriptions and initial selections", () => {
    const element = checkboxes({
      actionId: "mods",
      options: [
        { value: "quick", text: "Quick" },
        { value: "urgent", text: "Urgent", description: "4h reminders" },
      ],
      initialValues: ["urgent"],
    });
    const urgent = {
      value: "urgent",
      text: { type: "plain_text", text: "Urgent", emoji: true },
      description: { type: "plain_text", text: "4h reminders", emoji: true },
    };
    expect(element).toEqual({
      type: "checkboxes",
      action_id: "mods",
      options: [{ value: "quick", text: { type: "plain_text", text: "Quick", emoji: true } }, urgent],
      initial_options: [urgent],
    });
    expect(checkboxes({ actionId: "x", options: [{ value: "a", text: "A" }] })).not.toHaveProperty("initial_options");
  });
});

describe("views", () => {
  it("builds a modal, truncating its title and buttons to 24 characters", () => {
    expect(modal({ callbackId: "form", title: "Request a PR review from the team", blocks: [] })).toEqual({
      type: "modal",
      callback_id: "form",
      title: { type: "plain_text", text: "Request a PR review fro…", emoji: true },
      blocks: [],
    });
    expect(
      modal({ callbackId: "f", title: "T", blocks: [], submit: "Send", close: "Cancel", privateMetadata: "" }),
    ).toMatchObject({
      submit: { type: "plain_text", text: "Send" },
      close: { type: "plain_text", text: "Cancel" },
      private_metadata: "",
    });
  });

  it("builds a home view", () => {
    expect(homeView([divider()])).toEqual({ type: "home", blocks: [{ type: "divider" }] });
  });
});
