import { z } from "zod";
import type { JobRef } from "../../core/jobs";
import type { GitHubWebhookEvent, GitHubWebhookHandler } from "../../github";
import type { PRContext } from "./refresh";

export const prKeySchema = z.object({ repo: z.string(), number: z.number().int().positive() });
export type PRKey = z.infer<typeof prKeySchema>;

export const commitKeySchema = z.object({ repo: z.string(), sha: z.string().min(1) });
export type CommitKey = z.infer<typeof commitKeySchema>;

/** Coalesces a burst of events on one PR into one refresh (spec §4.3B and §4.5: 60 seconds). */
export const REFRESH_DEBOUNCE = { windowSeconds: 60, maxWaitSeconds: 300 };

/** Actions that can change a PR's state or modifiers. `check_run` and `status` events always can. */
const RELEVANT_ACTIONS: Partial<Record<GitHubWebhookEvent["name"], ReadonlySet<string>>> = {
  pull_request: new Set([
    "opened",
    "reopened",
    "closed",
    "converted_to_draft",
    "ready_for_review",
    "review_requested",
    "review_request_removed",
    "synchronize",
    "edited",
    "enqueued",
    "dequeued",
    // Labels carry the modifiers (spec §4.3A).
    "labeled",
    "unlabeled",
  ]),
  pull_request_review: new Set(["submitted", "dismissed", "edited"]),
};

const subjectPayload = z.object({
  requested_reviewer: z.object({ login: z.string() }).nullish(),
  requested_team: z.object({ slug: z.string() }).nullish(),
  review: z.object({ state: z.string() }).nullish(),
});

export interface PRJobs {
  refresh: JobRef<PRKey>;
  resolveCommit: JobRef<CommitKey>;
}

/** Case-insensitive lookup of a tracked repo, returning the configured spelling. */
export function trackedRepos(repos: readonly string[]): (name: string | null) => string | null {
  const byKey = new Map(repos.map((repo) => [repo.toLowerCase(), repo]));
  return (name) => (name ? (byKey.get(name.toLowerCase()) ?? null) : null);
}

/**
 * Records the event and debounces a refresh of each PR it concerns. Must stay fast: GitHub gives
 * up after 10 seconds, so the GitHub read happens later in the refresh job.
 */
export function createWebhookHandler(ctx: PRContext, jobs: PRJobs): GitHubWebhookHandler {
  const { services, store } = ctx;
  const tracked = trackedRepos(ctx.config.repos);

  return async (event) => {
    const repo = tracked(event.repo);
    if (!repo || !isRelevant(event)) return;

    let numbers = event.pullRequests;
    if (numbers.length === 0 && event.headSha) {
      numbers = await store.openNumbersForHead(repo, event.headSha);
      if (numbers.length === 0) {
        // A fork PR's check run or a commit status for a head Nathan hasn't stored yet (or a
        // commit that isn't any PR's head): ask GitHub, once per commit.
        const key = `${repo}@${event.headSha}`;
        await services.debounce(jobs.resolveCommit, key, { repo, sha: event.headSha }, REFRESH_DEBOUNCE);
        return;
      }
    }

    for (const number of numbers) {
      await store.recordEvent(repo, number, {
        event: event.name,
        action: event.action,
        actor: event.sender,
        subject: subjectOf(event.payload),
        receivedAt: services.clock.now(),
      });
      if (event.name === "pull_request" && event.headSha) await store.setHeadSha(repo, number, event.headSha);
      await debounceRefresh(ctx, jobs.refresh, { repo, number });
    }
  };
}

/** The `resolve_commit` job: finds the open PRs whose head is the commit and refreshes them. */
export async function resolveCommit(ctx: PRContext, refresh: JobRef<PRKey>, { repo, sha }: CommitKey): Promise<void> {
  const numbers = await ctx.services.github.reader.openPullRequestsForCommit(repo, sha);
  for (const number of numbers) await debounceRefresh(ctx, refresh, { repo, number });
}

function debounceRefresh(ctx: PRContext, refresh: JobRef<PRKey>, key: PRKey): Promise<void> {
  return ctx.services.debounce(refresh, `${key.repo}#${key.number}`, key, REFRESH_DEBOUNCE);
}

function isRelevant(event: GitHubWebhookEvent): boolean {
  const actions = RELEVANT_ACTIONS[event.name];
  return !actions || (event.action !== null && actions.has(event.action));
}

function subjectOf(payload: Record<string, unknown>): string | null {
  const parsed = subjectPayload.safeParse(payload).data;
  return (
    parsed?.requested_reviewer?.login ?? parsed?.requested_team?.slug ?? parsed?.review?.state.toLowerCase() ?? null
  );
}
