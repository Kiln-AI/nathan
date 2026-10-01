import type { DateTime } from "luxon";
import type { Logger } from "../core/log";
import type { GraphqlError, GraphqlResult, ReadOnlyGraphql } from "./client";
import { GitHubApiError } from "./errors";
import {
  compact,
  type RawCommits,
  type RawPullRequest,
  type RawPullRequestHistory,
  toChecks,
  toPRData,
  toPRHistory,
} from "./normalize";
import { OPEN_HEADS_QUERY, PULL_REQUEST_QUERY, recentQuery, requiredChecksQuery, sweepQuery } from "./queries";
import { parseRepo } from "./repo";
import type { GitHubReader, PRData, PRHistory, SweepResult } from "./types";

/** PRs per `isRequired` query. Each alias is a small query, so this keeps one request modest. */
export const REQUIRED_CHECKS_BATCH_SIZE = 20;

interface Page<N> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: (N | null)[];
}

type AliasedRepos<N> = Record<string, { pullRequests: Page<N> } | null> & { rateLimit?: { cost: number } | null };

export function createGitHubReader({ graphql, log }: { graphql: ReadOnlyGraphql; log: Logger }): GitHubReader {
  /**
   * Pages every repo's PR connection together: one aliased query per round, and only repos with
   * more pages stay in the next round. `keepPaging` lets a caller stop a repo early.
   */
  async function pageRepos<N>(
    repos: readonly string[],
    query: (count: number) => string,
    onPage: (repo: string, nodes: N[]) => { keepPaging: boolean },
  ): Promise<{ missingRepos: string[]; cost: number }> {
    let pending = [...new Set(repos)].map((repo) => ({ repo, ...parseRepo(repo), cursor: null as string | null }));
    const missingRepos: string[] = [];
    let cost = 0;
    while (pending.length > 0) {
      const variables: Record<string, unknown> = {};
      pending.forEach(({ owner, name, cursor }, i) => {
        Object.assign(variables, { [`o${i}`]: owner, [`n${i}`]: name, [`c${i}`]: cursor });
      });
      const { data, errors } = await graphql<AliasedRepos<N>>(query(pending.length), variables);
      assertOnlyNotFound(errors);
      cost += data?.rateLimit?.cost ?? 0;
      const next: typeof pending = [];
      pending.forEach((entry, i) => {
        const connection = data?.[`r${i}`]?.pullRequests;
        if (!connection) {
          missingRepos.push(entry.repo);
          log.warn("GitHub repository not found; is the App installed on it?", { repo: entry.repo });
          return;
        }
        const { keepPaging } = onPage(entry.repo, compact(connection.nodes));
        if (keepPaging && connection.pageInfo.hasNextPage)
          next.push({ ...entry, cursor: connection.pageInfo.endCursor });
      });
      pending = next;
    }
    return { missingRepos, cost };
  }

  /**
   * Phase two of the sweep: `isRequired` takes the PR number as an argument, so it can't be asked
   * in the list query. Only PRs with a failing check need it. `mergeStateStatus` isn't used as a
   * shortcut: when no check is required, "any failing check counts" (spec §4.2), which UNSTABLE hides.
   */
  async function withRequiredChecks(prs: PRData[]): Promise<{ prs: PRData[]; cost: number }> {
    const failing = prs.filter((pr) => pr.checks.some((check) => check.outcome === "failure"));
    const resolved = new Map<PRData, PRData>();
    let cost = 0;
    for (let start = 0; start < failing.length; start += REQUIRED_CHECKS_BATCH_SIZE) {
      const batch = failing.slice(start, start + REQUIRED_CHECKS_BATCH_SIZE);
      const variables: Record<string, unknown> = {};
      batch.forEach((pr, i) => {
        const { owner, name } = parseRepo(pr.repo);
        Object.assign(variables, { [`o${i}`]: owner, [`n${i}`]: name, [`p${i}`]: pr.number });
      });
      type Data = Record<string, { pullRequest: { headRefOid: string; commits: RawCommits } | null } | null> & {
        rateLimit?: { cost: number } | null;
      };
      const { data, errors } = await graphql<Data>(requiredChecksQuery(batch.length), variables);
      assertOnlyNotFound(errors);
      cost += data?.rateLimit?.cost ?? 0;
      batch.forEach((pr, i) => {
        const fresh = data?.[`p${i}`]?.pullRequest;
        // A PR that vanished between the two queries keeps its unresolved checks; the next sweep settles it.
        if (!fresh) return;
        const contexts = fresh.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
        // A push between the two queries moves the head: the checks and headSha must describe the same commit.
        resolved.set(pr, {
          ...pr,
          headSha: fresh.headRefOid,
          checks: toChecks(contexts?.nodes ?? []),
          checksTruncated: contexts?.pageInfo.hasNextPage ?? false,
        });
      });
    }
    return { prs: prs.map((pr) => resolved.get(pr) ?? pr), cost };
  }

  return {
    async openPullRequests(repos): Promise<SweepResult> {
      const listed: PRData[] = [];
      const { missingRepos, cost } = await pageRepos<RawPullRequest>(repos, sweepQuery, (repo, nodes) => {
        listed.push(...nodes.map((node) => toPRData(repo, node)));
        return { keepPaging: true };
      });
      const required = await withRequiredChecks(listed);
      return { pullRequests: required.prs, missingRepos, cost: cost + required.cost };
    },

    async pullRequest(repo, number) {
      const { owner, name } = parseRepo(repo);
      const { data, errors } = await graphql<{ repository: { pullRequest: RawPullRequest | null } | null }>(
        PULL_REQUEST_QUERY,
        { owner, name, number },
      );
      assertOnlyNotFound(errors);
      const raw = data?.repository?.pullRequest;
      return raw ? toPRData(repo, raw) : null;
    },

    async recentPullRequests(repos, since: DateTime): Promise<PRHistory[]> {
      const recent: PRHistory[] = [];
      await pageRepos<RawPullRequestHistory>(repos, recentQuery, (repo, nodes) => {
        const prs = nodes.map((node) => toPRHistory(repo, node));
        recent.push(...prs.filter((pr) => pr.updatedAt >= since));
        // Pages are newest first: once a page reaches back past `since`, the rest are older.
        return { keepPaging: prs.every((pr) => pr.updatedAt >= since) };
      });
      return recent;
    },

    async openPullRequestsForCommit(repo, sha) {
      const { owner, name } = parseRepo(repo);
      const matches: number[] = [];
      type Data = { repository: { pullRequests: Page<{ number: number; headRefOid: string }> } | null };
      let cursor: string | null = null;
      do {
        const result: GraphqlResult<Data> = await graphql<Data>(OPEN_HEADS_QUERY, { owner, name, cursor });
        assertOnlyNotFound(result.errors);
        const connection: Page<{ number: number; headRefOid: string }> | undefined =
          result.data?.repository?.pullRequests;
        if (!connection) return matches;
        for (const pr of compact(connection.nodes)) {
          if (pr.headRefOid.toLowerCase() === sha.toLowerCase()) matches.push(pr.number);
        }
        cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      } while (cursor);
      return matches;
    },
  };
}

/** NOT_FOUND nulls out just that part of the response; anything else fails the call. */
function assertOnlyNotFound(errors: GraphqlError[]): void {
  const unexpected = errors.filter((error) => error.type !== "NOT_FOUND");
  if (unexpected.length > 0) {
    throw new GitHubApiError(`GitHub GraphQL error: ${unexpected.map((error) => error.message).join("; ")}`, 200);
  }
}
