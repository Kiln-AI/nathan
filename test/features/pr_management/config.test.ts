import { describe, expect, it } from "vitest";
import config from "../../../nathan.config";
import { loadConfig } from "../../../src/core/config";
import { features } from "../../../src/features";
import { prManagement } from "../../../src/features/pr_management";
import {
  DEFAULT_BOT_AUTHORS,
  DEFAULT_REMINDER_TEMPLATES,
  DEFAULT_WIP_TITLE_PATTERN,
} from "../../../src/features/pr_management/config";
import { prApp, prConfig } from "../../helpers/pr";

const load = (overrides: Record<string, unknown> = {}) =>
  loadConfig(prConfig(overrides), "development", [prManagement]).features.get("pr_management");

describe("pr_management config", () => {
  it("fills in defaults", () => {
    expect(load()).toEqual({
      repos: ["Kiln-AI/Kiln", "Kiln-AI/nathan"],
      channel: "CPRS",
      triager: "dan",
      botAuthors: DEFAULT_BOT_AUTHORS,
      wipTitlePattern: DEFAULT_WIP_TITLE_PATTERN,
      reminders: {
        thresholdHours: 24,
        thresholdHoursByState: {},
        urgentThresholdHours: 4,
        templates: DEFAULT_REMINDER_TEMPLATES,
      },
      drafts: { nudgeAfterDays: 14, nudgeEveryDays: 7 },
    });
  });

  it("fills in the defaults a partial reminders or drafts section leaves out", () => {
    expect(
      load({
        reminders: { thresholdHoursByState: { awaiting_review: 8 }, templates: [["Ping"]] },
        drafts: { nudgeEveryDays: 3 },
      }),
    ).toMatchObject({
      reminders: { thresholdHours: 24, thresholdHoursByState: { awaiting_review: 8 }, templates: [["Ping"]] },
      drafts: { nudgeAfterDays: 14, nudgeEveryDays: 3 },
    });
  });

  it("ships at least two variants for each of levels 1, 2, 3 and 4+", () => {
    expect(DEFAULT_REMINDER_TEMPLATES).toHaveLength(4);
    for (const group of DEFAULT_REMINDER_TEMPLATES) expect(group.length).toBeGreaterThanOrEqual(2);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a repo without an owner", { repos: ["Kiln"] }, "features.pr_management.repos.0: must be owner/name"],
    [
      "an owner GitHub wouldn't allow",
      { repos: ["Kiln_AI/Kiln"] },
      "features.pr_management.repos.0: must be owner/name",
    ],
    ["no repos", { repos: [] }, "features.pr_management.repos"],
    ["a duplicate repo", { repos: ["a/b", "A/B"] }, 'features.pr_management.repos.1: duplicate repo "A/B"'],
    ["a channel name", { channel: "#prs" }, "features.pr_management.channel: must be a Slack channel ID"],
    ["a bad WIP pattern", { wipTitlePattern: "([" }, "features.pr_management.wipTitlePattern: not a valid regular"],
    ["an unknown key", { channels: "x" }, "features.pr_management"],
    ["a zero threshold", { reminders: { thresholdHours: 0 } }, "features.pr_management.reminders.thresholdHours"],
    [
      "a threshold for a state that gets no reminders",
      { reminders: { thresholdHoursByState: { draft: 5 } } },
      "features.pr_management.reminders.thresholdHoursByState",
    ],
    [
      "an empty template level",
      { reminders: { templates: [["Ping"], []] } },
      "features.pr_management.reminders.templates.1: needs at least one variant",
    ],
    ["no template levels", { reminders: { templates: [] } }, "features.pr_management.reminders.templates"],
    ["a blank template", { reminders: { templates: [["  "]] } }, "features.pr_management.reminders.templates.0.0"],
    ["a fractional draft age", { drafts: { nudgeAfterDays: 1.5 } }, "features.pr_management.drafts.nudgeAfterDays"],
  ])("rejects %s", (_name, overrides, message) => {
    expect(() => load(overrides)).toThrow(message);
  });

  it("the shipped nathan.config.ts loads in every environment with the feature registered", () => {
    expect(features).toContain(prManagement);
    for (const envName of Object.keys(config.environments)) {
      expect(() => loadConfig(config, envName, features)).not.toThrow();
    }
  });

  it("warns at startup when the triager can't be tagged", () => {
    expect(prApp().log.at("warn")).toEqual([]);
    const h = prApp({ config: prConfig({ triager: "nobody" }) });
    expect(h.log.at("warn")).toMatchObject([
      { msg: expect.stringContaining("triager has no Slack mapping"), fields: { triager: "nobody" } },
    ]);
  });
});
