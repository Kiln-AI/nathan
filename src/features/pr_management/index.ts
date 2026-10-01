import { defineFeature } from "../../core/feature";
import { GITHUB_EVENTS } from "../../github";
import { prConfigSchema } from "./config";
import { createPeople } from "./people";
import { registerPersonalQueue } from "./personal_queue";
import { registerPRReport } from "./pr_report";
import { type PRContext, refreshPullRequest } from "./refresh";
import { postDailyReport, reportSchedule } from "./report";
import { registerRequestPR } from "./request";
import { createPRStore } from "./store";
import { sweep } from "./sweep";
import { commitKeySchema, createWebhookHandler, prKeySchema, resolveCommit, trackedRepos } from "./webhooks";

/** PR/CR management (spec §4): every open PR has a state, next step and owner, visible in Slack. */
export const prManagement = defineFeature({
  id: "pr_management",
  configSchema: prConfigSchema,
  register(registrar) {
    const { config, services } = registrar;
    const ctx: PRContext = {
      config,
      services,
      store: createPRStore(services.db),
      people: createPeople(services.directory, config.triager),
    };
    if (!services.directory.byGithub(config.triager)) {
      services.log.warn("The PR triager has no Slack mapping in config users, so nobody can be tagged for them", {
        triager: config.triager,
      });
    }
    const tracked = trackedRepos(config.repos);

    const refresh = registrar.jobs.define("refresh", prKeySchema, async ({ repo, number }) => {
      // Queued before the repo was removed from config: its PRs are no longer tracked.
      const configured = tracked(repo);
      if (configured) await refreshPullRequest(ctx, configured, number);
    });
    const resolveCommitJob = registrar.jobs.define("resolve_commit", commitKeySchema, (commit) =>
      resolveCommit(ctx, refresh, commit),
    );

    const onWebhook = createWebhookHandler(ctx, { refresh, resolveCommit: resolveCommitJob });
    for (const event of GITHUB_EVENTS) registrar.github.on(event, onWebhook);

    registrar.schedule({ name: "sweep", when: { everyHour: true }, run: () => sweep(ctx) });
    registrar.schedule({
      name: "daily_report",
      when: reportSchedule(config.report),
      run: ({ firedAt }) => postDailyReport(ctx, firedAt),
    });

    registerRequestPR(registrar, ctx);
    registerPersonalQueue(registrar, ctx);
    registerPRReport(registrar, ctx);
  },
});
