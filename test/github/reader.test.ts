import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../../src/github/errors";
import { REQUIRED_CHECKS_BATCH_SIZE } from "../../src/github/reader";
import openHeads1 from "../fixtures/github/open_heads_page1.json?raw";
import openHeads2 from "../fixtures/github/open_heads_page2.json?raw";
import pullRequest from "../fixtures/github/pull_request.json?raw";
import pullRequestNotFound from "../fixtures/github/pull_request_not_found.json?raw";
import recent1 from "../fixtures/github/recent_page1.json?raw";
import recent2 from "../fixtures/github/recent_page2.json?raw";
import requiredChecks from "../fixtures/github/required_checks.json?raw";
import sweepMissingRepo from "../fixtures/github/sweep_missing_repo.json?raw";
import sweep1 from "../fixtures/github/sweep_page1.json?raw";
import sweep2 from "../fixtures/github/sweep_page2.json?raw";
import { type ApiCall, fixture, stubbedGateway } from "../helpers/github";

interface GraphqlCall {
  operation: string;
  query: string;
  variables: Record<string, unknown>;
}

/** Answers each GraphQL operation (by name) from a queue of fixtures. */
function graphqlStub(responses: Record<string, string[]>) {
  const graphqlCalls: GraphqlCall[] = [];
  const respond = (call: ApiCall) => {
    const query = String(call.body?.query);
    const variables = (call.body?.variables ?? {}) as Record<string, unknown>;
    const operation = /query (\w+)/.exec(query)?.[1] ?? "?";
    graphqlCalls.push({ operation, query, variables });
    const next = responses[operation]?.shift();
    if (!next) throw new Error(`Unexpected ${operation} query`);
    return fixture(next);
  };
  return { ...stubbedGateway(respond), graphqlCalls };
}

const iso = (time: DateTime | null) => time?.toISO() ?? null;

describe("openPullRequests (the sweep)", () => {
  it("reads every repo in one aliased query, pages per repo, then resolves required checks for failing PRs", async () => {
    const { gateway, graphqlCalls } = graphqlStub({
      Sweep: [sweep1, sweep2],
      RequiredChecks: [requiredChecks],
    });
    const result = await gateway.reader.openPullRequests(["Kiln-AI/Kiln", "Kiln-AI/nathan"]);

    expect(graphqlCalls.map((c) => [c.operation, c.variables])).toEqual([
      ["Sweep", { o0: "Kiln-AI", n0: "Kiln", c0: null, o1: "Kiln-AI", n1: "nathan", c1: null }],
      ["Sweep", { o0: "Kiln-AI", n0: "Kiln", c0: "Y3Vyc29yOjI=" }],
      ["RequiredChecks", { o0: "Kiln-AI", n0: "Kiln", p0: 101 }],
    ]);
    expect(result.pullRequests.map((pr) => `${pr.repo}#${pr.number}`)).toEqual([
      "Kiln-AI/Kiln#101",
      "Kiln-AI/Kiln#102",
      "Kiln-AI/nathan#7",
      "Kiln-AI/Kiln#103",
    ]);
    expect(result.missingRepos).toEqual([]);
    expect(result.cost).toBe(6);
  });

  it("annotates every check of a failing PR with isRequired, and leaves passing PRs unresolved", async () => {
    const { gateway } = graphqlStub({ Sweep: [sweep1, sweep2], RequiredChecks: [requiredChecks] });
    const { pullRequests } = await gateway.reader.openPullRequests(["Kiln-AI/Kiln", "Kiln-AI/nathan"]);
    const byNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));
    expect(byNumber.get(101)?.checks).toEqual([
      { name: "test", source: "check_run", outcome: "success", required: true },
      { name: "lint", source: "check_run", outcome: "failure", required: false },
      { name: "ci/circleci", source: "status", outcome: "success", required: true },
    ]);
    expect(byNumber.get(103)?.checks).toEqual([
      { name: "test", source: "check_run", outcome: "success", required: null },
    ]);
  });

  it("asks isRequired by PR number variable, never by interpolating values into the query", async () => {
    const { gateway, graphqlCalls } = graphqlStub({ Sweep: [sweep1, sweep2], RequiredChecks: [requiredChecks] });
    await gateway.reader.openPullRequests(["Kiln-AI/Kiln", "Kiln-AI/nathan"]);
    const required = graphqlCalls.find((c) => c.operation === "RequiredChecks")?.query ?? "";
    expect(required).toContain("isRequired(pullRequestNumber: $p0)");
    expect(required).not.toContain("Kiln-AI");
  });

  it("keeps headSha and checks on the same commit when a push lands between the two queries", async () => {
    const pushed = fixture(requiredChecks) as {
      data: { p0: { pullRequest: { headRefOid: string; commits: { nodes: unknown[] } } } };
    };
    pushed.data.p0.pullRequest.headRefOid = "ffff000000000000000000000000000000000006";
    pushed.data.p0.pullRequest.commits.nodes = [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "test",
                  status: "QUEUED",
                  conclusion: null,
                  startedAt: null,
                  completedAt: null,
                  isRequired: true,
                },
              ],
            },
          },
        },
      },
    ];
    const { gateway } = graphqlStub({ Sweep: [sweep1, sweep2], RequiredChecks: [JSON.stringify(pushed)] });
    const { pullRequests } = await gateway.reader.openPullRequests(["Kiln-AI/Kiln", "Kiln-AI/nathan"]);
    expect(pullRequests.find((pr) => pr.number === 101)).toMatchObject({
      headSha: "ffff000000000000000000000000000000000006",
      checks: [{ name: "test", source: "check_run", outcome: "pending", required: true }],
    });
  });

  it("asks for the head commit alongside the required checks", async () => {
    const { gateway, graphqlCalls } = graphqlStub({ Sweep: [sweep1, sweep2], RequiredChecks: [requiredChecks] });
    const { pullRequests } = await gateway.reader.openPullRequests(["Kiln-AI/Kiln", "Kiln-AI/nathan"]);
    expect(graphqlCalls.find((c) => c.operation === "RequiredChecks")?.query).toContain("headRefOid");
    expect(pullRequests.find((pr) => pr.number === 101)?.headSha).toBe("0000000000000000000000000000000000000065");
  });

  it("skips the second query when nothing is failing", async () => {
    const { gateway, graphqlCalls } = graphqlStub({ Sweep: [sweep2] });
    await gateway.reader.openPullRequests(["Kiln-AI/Kiln"]);
    expect(graphqlCalls.map((c) => c.operation)).toEqual(["Sweep"]);
  });

  it("splits required-check lookups into batches", async () => {
    const page = fixture(sweep1) as { data: { r0: { pullRequests: { nodes: Record<string, unknown>[] } } } };
    const failingPR = page.data.r0.pullRequests.nodes[0] as Record<string, unknown>;
    const count = REQUIRED_CHECKS_BATCH_SIZE + 1;
    const manyFailing = {
      data: {
        r0: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: Array.from({ length: count }, (_, i) => ({ ...failingPR, number: i + 1 })),
          },
        },
        rateLimit: { cost: 1 },
      },
    };
    const { gateway, graphqlCalls } = graphqlStub({
      Sweep: [JSON.stringify(manyFailing)],
      RequiredChecks: [JSON.stringify({ data: {} }), JSON.stringify({ data: {} })],
    });
    const { pullRequests } = await gateway.reader.openPullRequests(["Kiln-AI/Kiln"]);
    const batches = graphqlCalls.filter((c) => c.operation === "RequiredChecks");
    expect(batches.map((c) => Object.keys(c.variables).filter((k) => k.startsWith("p")).length)).toEqual([
      REQUIRED_CHECKS_BATCH_SIZE,
      1,
    ]);
    // PRs GitHub didn't return in phase two keep their unresolved checks.
    expect(pullRequests[0]?.checks.every((check) => check.required === null)).toBe(true);
  });

  it("reports a repo GitHub can't find instead of failing the sweep", async () => {
    const { gateway, log } = graphqlStub({ Sweep: [sweepMissingRepo] });
    const result = await gateway.reader.openPullRequests(["Kiln-AI/gone", "Kiln-AI/nathan"]);
    expect(result.missingRepos).toEqual(["Kiln-AI/gone"]);
    expect(result.pullRequests.map((pr) => pr.number)).toEqual([7]);
    expect(log.at("warn")).toMatchObject([{ fields: { repo: "Kiln-AI/gone" } }]);
  });

  it("queries each repo once even when it is listed twice", async () => {
    const { gateway, graphqlCalls } = graphqlStub({ Sweep: [sweep2] });
    await gateway.reader.openPullRequests(["Kiln-AI/Kiln", "Kiln-AI/Kiln"]);
    expect(graphqlCalls[0]?.variables).toEqual({ o0: "Kiln-AI", n0: "Kiln", c0: null });
  });

  it("rejects a repo that isn't owner/name before calling GitHub", async () => {
    const { gateway, api } = graphqlStub({});
    await expect(gateway.reader.openPullRequests(["Kiln"])).rejects.toThrow('"Kiln" is not an owner/name repository');
    expect(api.apiCalls()).toEqual([]);
  });

  it("does nothing for an empty repo list", async () => {
    const { gateway, api } = graphqlStub({});
    expect(await gateway.reader.openPullRequests([])).toEqual({ pullRequests: [], missingRepos: [], cost: 0 });
    expect(api.calls).toEqual([]);
  });
});

describe("pullRequest", () => {
  it("reads one PR in any state with required checks resolved in the same query", async () => {
    const { gateway, graphqlCalls } = graphqlStub({ PullRequest: [pullRequest] });
    const pr = await gateway.reader.pullRequest("Kiln-AI/Kiln", 99);
    expect(graphqlCalls.map((c) => [c.operation, c.variables])).toEqual([
      ["PullRequest", { owner: "Kiln-AI", name: "Kiln", number: 99 }],
    ]);
    expect(graphqlCalls[0]?.query).toContain("isRequired(pullRequestNumber: $number)");
    expect(pr).toMatchObject({
      state: "merged",
      checks: [
        { name: "test", outcome: "failure", required: false },
        { name: "ci/circleci", outcome: "success", required: true },
      ],
    });
    expect(iso(pr?.mergedAt ?? null)).toBe("2026-10-03T12:00:00.000Z");
  });

  it("returns null when the PR doesn't exist", async () => {
    const { gateway } = graphqlStub({ PullRequest: [pullRequestNotFound] });
    expect(await gateway.reader.pullRequest("Kiln-AI/Kiln", 999)).toBeNull();
  });
});

describe("recentPullRequests", () => {
  it("pages newest first until it passes `since`, keeping every submitted review", async () => {
    const { gateway, graphqlCalls } = graphqlStub({ Recent: [recent1, recent2] });
    const since = DateTime.fromISO("2026-09-20T00:00:00Z", { zone: "utc" });
    const prs = await gateway.reader.recentPullRequests(["Kiln-AI/Kiln", "Kiln-AI/nathan"], since);

    // Page 2 reaches back past `since`, so Kiln stops there despite hasNextPage.
    expect(graphqlCalls.map((c) => c.variables)).toEqual([
      { o0: "Kiln-AI", n0: "Kiln", c0: null, o1: "Kiln-AI", n1: "nathan", c1: null },
      { o0: "Kiln-AI", n0: "Kiln", c0: "cmVjZW50OjI=" },
    ]);
    expect(prs.map((pr) => `${pr.repo}#${pr.number}:${pr.state}`)).toEqual([
      "Kiln-AI/Kiln#120:merged",
      "Kiln-AI/Kiln#118:open",
      "Kiln-AI/nathan#8:merged",
      "Kiln-AI/Kiln#110:closed",
    ]);
    const faster = prs[0];
    expect(faster?.reviews.map((r) => [r.author, r.state, iso(r.submittedAt)])).toEqual([
      ["carol", "commented", "2026-09-30T10:00:00.000Z"],
      ["bob", "approved", "2026-10-03T10:00:00.000Z"],
    ]);
    expect(iso(faster?.lastReadyForReviewAt ?? null)).toBe("2026-09-29T09:00:00.000Z");
    expect(prs[2]).toMatchObject({ author: "dependabot[bot]", authorIsBot: true, lastReadyForReviewAt: null });
  });
});

describe("openPullRequestsForCommit", () => {
  it("pages through open PRs and matches the head SHA case-insensitively", async () => {
    const { gateway, graphqlCalls } = graphqlStub({ OpenHeads: [openHeads1, openHeads2] });
    const numbers = await gateway.reader.openPullRequestsForCommit(
      "Kiln-AI/Kiln",
      "aaaa000000000000000000000000000000000001",
    );
    expect(numbers).toEqual([101, 140]);
    expect(graphqlCalls.map((c) => c.variables)).toEqual([
      { owner: "Kiln-AI", name: "Kiln", cursor: null },
      { owner: "Kiln-AI", name: "Kiln", cursor: "aGVhZHM6MQ==" },
    ]);
  });

  it("returns nothing for a repo GitHub can't find", async () => {
    const notFound = JSON.stringify({
      data: { repository: null },
      errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository" }],
    });
    const { gateway } = graphqlStub({ OpenHeads: [notFound] });
    expect(await gateway.reader.openPullRequestsForCommit("Kiln-AI/gone", "abc")).toEqual([]);
  });

  it("fails on unexpected GraphQL errors", async () => {
    const forbidden = JSON.stringify({ data: null, errors: [{ type: "FORBIDDEN", message: "no" }] });
    const { gateway } = graphqlStub({ OpenHeads: [forbidden] });
    await expect(gateway.reader.openPullRequestsForCommit("Kiln-AI/Kiln", "abc")).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});
