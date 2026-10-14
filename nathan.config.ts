import { defineConfig } from "./src/core/config";

// Nathan's team config. Reviewed via PR and validated in CI (`npm run check:config`).
// Slack channels and users are referenced by ID (in Slack: profile or channel details → "Copy ID").
// Secrets never go here; see docs/setup.md.
export default defineConfig({
  defaults: { timezone: "America/Toronto" },

  // GitHub ↔ Slack mapping. Add `tz: "Asia/Shanghai"` to override someone's Slack time zone.
  users: [
    { github: "sfierro", slack: "U095151EG3G" },
    { github: "scosman", slack: "U08MRKF53V1" },
    { github: "tawnymanticore", slack: "U0900P6DN1W" },
    { github: "chiang-daniel", slack: "U096XJV8MNF" },
    { github: "leonardmq", slack: "U094Z849W7Q" },
  ],

  // Job failures and dead-lettered jobs are posted here (#nathan_admin).
  admin: { slackChannel: "C0C661VAF6D" },

  features: {
    // PR/CR management (docs/setup.md).
    pr_management: {
      enabled: true,
      repos: ["Kiln-AI/Kiln", "Kiln-AI/kiln_server"],
      channel: "C0996APVD9R", // #prs
      triager: "chiang-daniel",
      // Daily report to #prs is off; `/nathan pr_report` still DMs it on demand.
      report: { enabled: false },
    },
  },

  // Deep-merged over the config above, selected by NATHAN_ENV (wrangler.jsonc).
  environments: {
    development: { dryRun: true, testChannel: "C0C63UUJXAN" },
    staging: {
      dryRun: true,
      testChannel: "C0C63UUJXAN",
      features: { pr_management: { enabled: true } },
    },
    production: {},
  },
});
