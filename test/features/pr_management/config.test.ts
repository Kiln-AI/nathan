import { describe, expect, it } from "vitest";
import config from "../../../nathan.config";
import { loadConfig } from "../../../src/core/config";
import { features } from "../../../src/features";
import { prManagement } from "../../../src/features/pr_management";
import { DEFAULT_BOT_AUTHORS, DEFAULT_WIP_TITLE_PATTERN } from "../../../src/features/pr_management/config";
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
    });
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
