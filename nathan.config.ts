import { defineConfig } from "./src/core/config";

// Nathan's team config. Reviewed via PR and validated in CI (`npm run check:config`).
// Slack channels and users are referenced by ID (in Slack: profile or channel details → "Copy ID").
// Secrets never go here; see docs/setup.md.
export default defineConfig({
  defaults: { timezone: "America/Toronto" },

  // GitHub ↔ Slack mapping. Add `tz: "Asia/Shanghai"` to override someone's Slack time zone.
  users: [],

  // Job failures and dead-lettered jobs are posted here.
  // TODO(setup): replace the placeholder with the real admin channel ID.
  admin: { slackChannel: "C00000ADMIN" },

  features: {},

  // Deep-merged over the config above, selected by NATHAN_ENV (wrangler.jsonc).
  environments: {
    development: { dryRun: true, testChannel: "C0000000TEST" },
    staging: { dryRun: true, testChannel: "C0000000TEST" },
    production: {},
  },
});
