import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createInstallationTokens, readGitHubAppCredentials } from "../../src/github/auth";
import { assertReadOnly, createGitHubHttp, createTokenRequest } from "../../src/github/client";
import { GitHubApiError, RateLimitedError } from "../../src/github/errors";
import { FakeClock } from "../fakes/clock";
import { stubbedGateway, stubGitHubApi } from "../helpers/github";

describe("GitHub HTTP client", () => {
  it("authenticates API calls with the installation token", async () => {
    const { gateway, api } = stubbedGateway(() => ({ data: { repository: { pullRequest: null } } }));
    await gateway.reader.pullRequest("Kiln-AI/Kiln", 1);
    expect(api.apiCalls()).toMatchObject([{ method: "POST", path: "/graphql", authorization: "token ghs_token1" }]);
  });

  it("drops a rejected token so the next call mints a new one", async () => {
    let first = true;
    const { gateway, api } = stubbedGateway(() => {
      if (!first) return { data: { repository: { pullRequest: null } } };
      first = false;
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    });
    await expect(gateway.reader.pullRequest("Kiln-AI/Kiln", 1)).rejects.toMatchObject({
      name: "GitHubApiError",
      status: 401,
    });
    await gateway.reader.pullRequest("Kiln-AI/Kiln", 1);
    expect(api.apiCalls().map((call) => call.authorization)).toEqual(["token ghs_token1", "token ghs_token2"]);
  });

  it("maps REST rate limits to RateLimitedError", async () => {
    const { gateway } = stubbedGateway(() =>
      Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "retry-after": "42" } }),
    );
    const error = await gateway.writer.requestReviewers("Kiln-AI/Kiln", 1, ["bob"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ retryAfterSeconds: 42 });
  });

  it("maps a GraphQL rate limit to RateLimitedError", async () => {
    const { gateway } = stubbedGateway(() => ({
      data: null,
      errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    }));
    await expect(gateway.reader.pullRequest("Kiln-AI/Kiln", 1)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("fails on GraphQL errors other than NOT_FOUND", async () => {
    const { gateway } = stubbedGateway(() => ({
      data: null,
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
    }));
    const error = await gateway.reader.pullRequest("Kiln-AI/Kiln", 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ message: "GitHub GraphQL error: Resource not accessible by integration" });
  });
});

describe("assertReadOnly", () => {
  it("stops the GraphQL helper before anything is sent", async () => {
    const api = stubGitHubApi();
    const clock = new FakeClock();
    const tokens = createInstallationTokens({
      credentials: readGitHubAppCredentials(env),
      kv: env.NATHAN_KV,
      clock,
      request: createTokenRequest(api.fetch),
    });
    const http = createGitHubHttp({ tokens, clock, fetch: api.fetch });
    await expect(http.graphql("mutation { x }")).rejects.toThrow("must not contain a mutation");
    expect(api.calls).toEqual([]);
  });

  it("rejects any document containing a mutation", () => {
    expect(() => assertReadOnly("mutation { requestReviews(input: {}) { clientMutationId } }")).toThrow(
      "must not contain a mutation",
    );
    expect(() => assertReadOnly("query { a } MUTATION { b }")).toThrow("must not contain a mutation");
  });

  it("allows queries", () => {
    expect(() => assertReadOnly("query Sweep { rateLimit { cost } }")).not.toThrow();
  });
});
