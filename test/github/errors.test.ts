import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { RetryAfterError } from "../../src/core/errors";
import {
  DEFAULT_RATE_LIMIT_RETRY_SECONDS,
  GitHubApiError,
  RateLimitedError,
  toGitHubError,
} from "../../src/github/errors";

const now = DateTime.fromISO("2026-10-05T14:00:00Z", { zone: "utc" });

function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { name: "HttpError", status, response: { headers } });
}

function graphqlError(errors: { type?: string; message: string }[], headers: Record<string, string> = {}) {
  return Object.assign(new Error("graphql failed"), { name: "GraphqlResponseError", errors, headers });
}

describe("toGitHubError", () => {
  it("maps an exhausted primary rate limit to a retry at the reset time", () => {
    const reset = String(now.plus({ seconds: 90 }).toSeconds());
    const mapped = toGitHubError(httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), now);
    expect(mapped).toBeInstanceOf(RateLimitedError);
    expect(mapped).toBeInstanceOf(RetryAfterError);
    expect((mapped as RateLimitedError).retryAfterSeconds).toBe(90);
  });

  it("waits at least a second when the reset time has already passed", () => {
    const reset = String(now.minus({ seconds: 5 }).toSeconds());
    const mapped = toGitHubError(httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), now);
    expect((mapped as RateLimitedError).retryAfterSeconds).toBe(1);
  });

  it("honours retry-after on a secondary limit", () => {
    const mapped = toGitHubError(httpError(429, { "retry-after": "30" }), now);
    expect(mapped).toMatchObject({ name: "RateLimitedError", retryAfterSeconds: 30 });
  });

  it("falls back to a minute when GitHub doesn't say when to retry", () => {
    const mapped = toGitHubError(httpError(429), now);
    expect((mapped as RateLimitedError).retryAfterSeconds).toBe(DEFAULT_RATE_LIMIT_RETRY_SECONDS);
  });

  it("treats a 403 secondary rate limit without headers as a rate limit", () => {
    const error = Object.assign(httpError(403), {
      message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    });
    expect(toGitHubError(error, now)).toMatchObject({
      name: "RateLimitedError",
      retryAfterSeconds: DEFAULT_RATE_LIMIT_RETRY_SECONDS,
    });
  });

  it("maps other HTTP errors, including a 403 that isn't a rate limit, to GitHubApiError", () => {
    for (const status of [403, 404, 422, 502]) {
      const mapped = toGitHubError(httpError(status), now);
      expect(mapped).toBeInstanceOf(GitHubApiError);
      expect(mapped).toMatchObject({ status, message: `HTTP ${status}` });
    }
  });

  it("maps a GraphQL RATE_LIMITED error to RateLimitedError", () => {
    const reset = String(now.plus({ minutes: 10 }).toSeconds());
    const mapped = toGitHubError(
      graphqlError([{ type: "RATE_LIMITED", message: "slow down" }], { "x-ratelimit-reset": reset }),
      now,
    );
    expect(mapped).toMatchObject({ name: "RateLimitedError", retryAfterSeconds: 600 });
  });

  it("maps other GraphQL errors to GitHubApiError", () => {
    const mapped = toGitHubError(graphqlError([{ type: "FORBIDDEN", message: "nope" }]), now);
    expect(mapped).toBeInstanceOf(GitHubApiError);
    expect(mapped).toMatchObject({ status: 200 });
  });

  it("passes anything else through untouched", () => {
    const error = new TypeError("network down");
    expect(toGitHubError(error, now)).toBe(error);
    expect(toGitHubError("weird", now)).toBe("weird");
  });
});
