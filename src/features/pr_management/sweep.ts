import { RateLimitedError } from "../../github";
import { type PRContext, type PRSnapshot, refreshPullRequest } from "./refresh";

/** Unconsumed events older than this belong to PRs no refresh will pick up again. */
export const EVENT_RETENTION_DAYS = 7;

const SOURCE = "pr_management.sweep";

/**
 * The hourly reconciliation (spec §5): re-read every tracked open PR from GitHub and correct the
 * records and cards, so correctness never depends on webhooks. Stored PRs the sweep no longer
 * returns are re-read one by one, which finalizes merged, closed and vanished PRs.
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
    for (const pr of pullRequests) await refreshOne(ctx, pr.repo, pr.number, { pr, readAt });

    const missing = new Set(missingRepos);
    const gone = (await store.openRecords(config.repos)).filter(
      (record) => !seen.has(`${record.repo}#${record.number}`) && !missing.has(record.repo),
    );
    for (const record of gone) await refreshOne(ctx, record.repo, record.number);
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error;
    // The next hourly sweep catches up.
    services.log.warn("GitHub rate limit hit; sweep stopped early", { retryAfterSeconds: error.retryAfterSeconds });
  }
  await store.pruneEvents(services.clock.now().minus({ days: EVENT_RETENTION_DAYS }));
}

/** One PR's failure is reported and the sweep moves on; a rate limit stops the whole sweep. */
async function refreshOne(ctx: PRContext, repo: string, number: number, snapshot?: PRSnapshot): Promise<void> {
  try {
    await refreshPullRequest(ctx, repo, number, snapshot);
  } catch (error) {
    if (error instanceof RateLimitedError) throw error;
    await ctx.services.reportError(error, { source: SOURCE, repo, number });
  }
}
