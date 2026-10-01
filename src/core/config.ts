import { z } from "zod";
import type { AnyFeature } from "./feature";
import { isValidTimeZone } from "./time";

const timeZone = z.string().refine(isValidTimeZone, { message: "not a valid IANA time zone" });

/** Slack channels are referenced by ID: names change, and the API needs IDs. */
export const slackChannelId = z
  .string()
  .regex(/^[CGD][A-Z0-9]{2,}$/, "must be a Slack channel ID (like C0123ABCD), not a name");

export const slackUserId = z.string().regex(/^[UW][A-Z0-9]{2,}$/, "must be a Slack user ID (like U0123ABCD)");

const userSchema = z.strictObject({
  github: z.string().min(1),
  slack: slackUserId,
  /** Overrides the Slack profile time zone. */
  tz: timeZone.optional(),
});

const featureSectionSchema = z.looseObject({ enabled: z.boolean() });

export const platformConfigSchema = z
  .strictObject({
    defaults: z.strictObject({ timezone: timeZone }),
    users: z.array(userSchema).default([]),
    admin: z.strictObject({ slackChannel: slackChannelId }),
    dryRun: z.boolean().default(false),
    testChannel: slackChannelId.optional(),
    features: z.record(z.string(), featureSectionSchema).default({}),
  })
  .superRefine((config, ctx) => {
    if (config.dryRun && !config.testChannel) {
      ctx.addIssue({ code: "custom", path: ["testChannel"], message: "is required when dryRun is true" });
    }
    reportDuplicates(
      config.users.map((u) => u.github.toLowerCase()),
      (index, value) =>
        ctx.addIssue({
          code: "custom",
          path: ["users", index, "github"],
          message: `duplicate GitHub login "${value}"`,
        }),
    );
    reportDuplicates(
      config.users.map((u) => u.slack),
      (index, value) =>
        ctx.addIssue({ code: "custom", path: ["users", index, "slack"], message: `duplicate Slack user "${value}"` }),
    );
  });

export type PlatformConfig = z.output<typeof platformConfigSchema>;
type PlatformConfigInput = z.input<typeof platformConfigSchema>;

/**
 * Each feature adds its config section's input type here via declaration merging, so a typo in
 * `nathan.config.ts` is a type error:
 *
 *   declare module "../../core/config" {
 *     interface FeatureSectionInputs { pr_management: z.input<typeof prConfigSchema> }
 *   }
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by features through declaration merging
export interface FeatureSectionInputs {}

type FeaturesInput = { [K in keyof FeatureSectionInputs]?: FeatureSectionInputs[K] & { enabled: boolean } };

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

type BaseConfigInput = Omit<PlatformConfigInput, "features"> & { features?: FeaturesInput };

export type NathanConfigInput = BaseConfigInput & {
  /** Overlays deep-merged over the base config, selected by the `NATHAN_ENV` var. */
  environments: Record<string, DeepPartial<BaseConfigInput>>;
};

/** Typed identity for `nathan.config.ts`. Validation happens in `loadConfig`. */
export function defineConfig(config: NathanConfigInput): NathanConfigInput {
  return config;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadedConfig {
  env: string;
  platform: PlatformConfig;
  /** Parsed config of each enabled feature, keyed by feature id (enabled features only). */
  features: ReadonlyMap<string, unknown>;
}

export function loadConfig(raw: unknown, envName: string, features: readonly AnyFeature[]): LoadedConfig {
  const fail = (problems: string[]): never => {
    throw new ConfigError(
      `Invalid config for environment "${envName}":\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  };

  if (!isPlainObject(raw)) return fail(["config must be an object"]);
  const { environments, ...base } = raw;
  if (!isPlainObject(environments)) return fail(["environments: must be an object"]);
  const overlay = environments[envName];
  if (!isPlainObject(overlay)) {
    return fail([`environments: no "${envName}" entry (have: ${Object.keys(environments).join(", ") || "none"})`]);
  }

  const parsed = platformConfigSchema.safeParse(deepMerge(base, overlay));
  if (!parsed.success) return fail(formatIssues([], parsed.error.issues));
  const platform = parsed.data;

  const problems: string[] = [];
  const known = new Set(features.map((f) => f.id));
  for (const id of Object.keys(platform.features)) {
    if (!known.has(id)) problems.push(`features.${id}: unknown feature (known: ${[...known].join(", ") || "none"})`);
  }

  const featureConfigs = new Map<string, unknown>();
  for (const feature of features) {
    const section = platform.features[feature.id];
    if (!section?.enabled) continue;
    const { enabled: _enabled, ...featureConfig } = section;
    const result = feature.configSchema.safeParse(featureConfig);
    if (result.success) featureConfigs.set(feature.id, result.data);
    else problems.push(...formatIssues(["features", feature.id], result.error.issues));
  }
  if (problems.length > 0) fail(problems);

  return { env: envName, platform, features: featureConfigs };
}

/** Objects merge key by key; arrays and scalars from the overlay replace the base value. */
export function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssues(prefix: PropertyKey[], issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = [...prefix, ...issue.path].map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

function reportDuplicates(values: string[], report: (index: number, value: string) => void): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) report(index, value);
    seen.add(value);
  });
}
