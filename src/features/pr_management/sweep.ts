import { type PRData, RateLimitedError } from "../../github";
import { nudgeDraftIfDue } from "./drafts";
import { type PRContext, refreshPullRequest } from "./refresh";
import { remindIfDue } from "./reminders";
import { isFinal } from "./status";

/** Unconsumed events older than this belong to PRs no refresh will pick up again. */
export const EVENT_RETENTION_DAYS = 7;

const SOURCE = "pr_management.sweep";

/**
 * The hourly reconciliation (spec §5): re-read every tracked open PR from GitHub and correct the
 * records and cards, so correctness never depends on webhooks. Stored PRs the sweep no longer
 * returns are re-read one by one, which finalizes merged, closed and vanished PRs. Each open PR
 * then gets its stale reminder (spec §4.6) or draft nudge (§4.8) if one is due.
 */
export async function sweep(ctx: PRContext): Promise<void> {
  const { config, services, store } = ctx;
  try {
    const readAt = services.clock.now();
    const { pullRequests, missingRepos } = await services.github.reader.openPullRequests(config.repos);
    if (missingRepos.length > 0) {
      await services.reportError(
        new Error(`GitHub didn't return ${missingRepos.join(", ")}. Is the GitHub App installed there?`),
        { source: SOURCE },
      );
    }

    const seen = new Set(pullRequests.map((pr) => `${pr.repo}#${pr.number}`));
    for (const pr of pullRequests) {
      await isolated(ctx, pr.repo, pr.number, async () => {
        await refreshPullRequest(ctx, pr.repo, pr.number, { pr, readAt });
        await followUp(ctx, pr);
      });
    }

    const missing = new Set(missingRepos);
    const gone = (await store.openRecords(config.repos)).filter(
      (record) => !seen.has(`${record.repo}#${record.number}`) && !missing.has(record.repo),
    );
    for (const record of gone) {
      await isolated(ctx, record.repo, record.number, () => refreshPullRequest(ctx, record.repo, record.number));
    }
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error;
    // The next hourly sweep catches up.
    services.log.warn("GitHub rate limit hit; sweep stopped early", { retryAfterSeconds: error.retryAfterSeconds });
  }
  await store.pruneEvents(services.clock.now().minus({ days: EVENT_RETENTION_DAYS }));
}

/** The reminder or draft nudge due on a freshly refreshed open PR, if any. */
async function followUp(ctx: PRContext, pr: PRData): Promise<void> {
  const record = await ctx.store.get(pr.repo, pr.number);
  if (!record || isFinal(record.state)) return;
  if (record.state === "draft") await nudgeDraftIfDue(ctx, record);
  else await remindIfDue(ctx, record, pr, Math.random);
}

/** One PR's failure is reported and the sweep moves on; a rate limit stops the whole sweep. */
async function isolated(ctx: PRContext, repo: string, number: number, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof RateLimitedError) throw error;
    await ctx.services.reportError(error, { source: SOURCE, repo, number });
  }
}
