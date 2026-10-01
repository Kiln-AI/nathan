/** A valid raw config (the shape of nathan.config.ts) for the "development" environment. */
export function aConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaults: { timezone: "America/Toronto" },
    users: [
      { github: "alice", slack: "UALICE" },
      { github: "bob", slack: "UBOB", tz: "Asia/Shanghai" },
    ],
    admin: { slackChannel: "CADMIN" },
    features: {},
    environments: { development: {}, staging: { dryRun: true, testChannel: "CTEST" }, production: {} },
    ...overrides,
  };
}
