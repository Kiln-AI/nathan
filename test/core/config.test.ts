import { describe, expect, it } from "vitest";
import { z } from "zod";
import repoConfig from "../../nathan.config";
import { ConfigError, deepMerge, defineConfig, loadConfig } from "../../src/core/config";
import { defineFeature } from "../../src/core/feature";
import { features as registeredFeatures } from "../../src/features";
import { aConfig } from "../builders/config";

const greeter = defineFeature({
  id: "greeter",
  configSchema: z.strictObject({ greeting: z.string(), repos: z.array(z.string()).default([]) }),
  register: () => {},
});

function loadError(raw: unknown, envName = "development", features = [greeter]): string {
  try {
    loadConfig(raw, envName, features);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("loads a valid config with defaults applied", () => {
    const loaded = loadConfig(aConfig(), "development", [greeter]);
    expect(loaded.env).toBe("development");
    expect(loaded.platform).toMatchObject({
      defaults: { timezone: "America/Toronto" },
      admin: { slackChannel: "CADMIN" },
      dryRun: false,
      features: {},
    });
    expect(loaded.platform.users).toHaveLength(2);
    expect(loaded.features.size).toBe(0);
  });

  it("deep-merges the environment overlay over the base", () => {
    const raw = aConfig({
      features: { greeter: { enabled: true, greeting: "hi", repos: ["a/b", "c/d"] } },
      environments: {
        staging: { dryRun: true, testChannel: "CTEST", features: { greeter: { repos: ["x/y"] } } },
      },
    });
    const loaded = loadConfig(raw, "staging", [greeter]);
    expect(loaded.platform.dryRun).toBe(true);
    expect(loaded.platform.testChannel).toBe("CTEST");
    expect(loaded.features.get("greeter")).toEqual({ greeting: "hi", repos: ["x/y"] });
  });

  it("validates enabled features with their schema, without the enabled flag", () => {
    const loaded = loadConfig(aConfig({ features: { greeter: { enabled: true, greeting: "hey" } } }), "development", [
      greeter,
    ]);
    expect(loaded.features.get("greeter")).toEqual({ greeting: "hey", repos: [] });
  });

  it("skips disabled features and features with no section", () => {
    const disabled = aConfig({ features: { greeter: { enabled: false, greeting: 42 } } });
    expect(loadConfig(disabled, "development", [greeter]).features.has("greeter")).toBe(false);
    expect(loadConfig(aConfig(), "development", [greeter]).features.has("greeter")).toBe(false);
  });

  it("reports feature schema errors under the feature's path", () => {
    const message = loadError(aConfig({ features: { greeter: { enabled: true, greting: "typo" } } }));
    expect(message).toContain('Invalid config for environment "development"');
    expect(message).toContain("features.greeter.greeting:");
    expect(message).toContain("features.greeter:"); // unrecognized key "greting"
  });

  it("rejects unknown feature sections", () => {
    expect(loadError(aConfig({ features: { greeterz: { enabled: true } } }))).toContain(
      "features.greeterz: unknown feature (known: greeter)",
    );
    expect(loadError(aConfig({ features: { x: { enabled: false } } }), "development", [])).toContain(
      "unknown feature (known: none)",
    );
  });

  it("requires a boolean enabled flag on feature sections", () => {
    expect(loadError(aConfig({ features: { greeter: { greeting: "hi" } } }))).toContain("features.greeter.enabled");
  });

  it("rejects an unknown environment, naming the known ones", () => {
    expect(loadError(aConfig(), "prod")).toContain('no "prod" entry (have: development, staging, production)');
  });

  it("rejects a config without environments, or that isn't an object", () => {
    expect(loadError({ ...aConfig(), environments: undefined })).toContain("environments: must be an object");
    expect(loadError([])).toContain("config must be an object");
    expect(loadError(aConfig({ environments: {} }))).toContain("(have: none)");
  });

  it.each([
    [
      "an invalid time zone",
      { defaults: { timezone: "Mars/Olympus" } },
      "defaults.timezone: not a valid IANA time zone",
    ],
    [
      "a channel name instead of an ID",
      { admin: { slackChannel: "#admin" } },
      "admin.slackChannel: must be a Slack channel ID",
    ],
    [
      "a bad user time zone",
      { users: [{ github: "a", slack: "UA", tz: "Nowhere" }] },
      "users.0.tz: not a valid IANA time zone",
    ],
    ["a bad Slack user ID", { users: [{ github: "a", slack: "alice" }] }, "users.0.slack: must be a Slack user ID"],
    ["dry run without a test channel", { dryRun: true }, "testChannel: is required when dryRun is true"],
    [
      "a duplicate GitHub login, ignoring case",
      {
        users: [
          { github: "Alice", slack: "UA" },
          { github: "alice", slack: "UB" },
        ],
      },
      'users.1.github: duplicate GitHub login "alice"',
    ],
    [
      "a duplicate Slack user",
      {
        users: [
          { github: "a", slack: "UA" },
          { github: "b", slack: "UA" },
        ],
      },
      'users.1.slack: duplicate Slack user "UA"',
    ],
    ["an unknown top-level key", { adminn: {} }, "adminn"],
  ])("rejects %s", (_name, overrides, expected) => {
    expect(loadError(aConfig(overrides))).toContain(expected);
  });

  it("lists every problem, one per line", () => {
    const message = loadError(aConfig({ defaults: { timezone: "Nope" }, admin: { slackChannel: "admin" } }));
    expect(message.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(2);
  });
});

describe("deepMerge", () => {
  it("merges nested objects, replaces arrays and scalars, and ignores undefined", () => {
    expect(
      deepMerge({ a: { b: 1, c: [1, 2] }, d: "x", e: 1 }, { a: { c: [3] }, d: { nested: true }, e: undefined }),
    ).toEqual({ a: { b: 1, c: [3] }, d: { nested: true }, e: 1 });
  });
});

describe("defineConfig", () => {
  it("returns the config unchanged", () => {
    const config = {
      defaults: { timezone: "UTC" },
      admin: { slackChannel: "CADMIN" },
      environments: { development: {} },
    };
    expect(defineConfig(config)).toBe(config);
  });
});

describe("nathan.config.ts", () => {
  it.each(Object.keys(repoConfig.environments))("is valid for the %s environment", (envName) => {
    expect(() => loadConfig(repoConfig, envName, registeredFeatures)).not.toThrow();
  });
});
