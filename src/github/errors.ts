import type { DateTime } from "luxon";
import { RetryAfterError } from "../core/errors";

/** A GitHub API call failed. `status` is the HTTP status (200 for GraphQL errors). */
export class GitHubApiError extends Error {
  override name = "GitHubApiError";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** GitHub's primary or secondary rate limit was hit. Jobs retry after `retryAfterSeconds`. */
export class RateLimitedError extends RetryAfterError {
  override name = "RateLimitedError";
}

/** Used when GitHub signals a rate limit without saying when it resets. */
export const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 60;

// Octokit's error classes live in transitive packages, so they're recognised by shape.
interface OctokitRequestError {
  name: "HttpError";
  message: string;
  status: number;
  response?: { headers: Record<string, string | number | undefined> };
}

interface OctokitGraphqlError {
  name: "GraphqlResponseError";
  message: string;
  errors?: { type?: string; message: string }[];
  headers?: Record<string, string | number | undefined>;
}

/** Maps Octokit errors to Nathan's GitHub errors; anything else passes through unchanged. */
export function toGitHubError(error: unknown, now: DateTime): unknown {
  if (isRequestError(error)) {
    const headers = error.response?.headers ?? {};
    // Secondary limits don't always send retry-after; GitHub's message names them.
    const isLimit =
      error.status === 429 ||
      (error.status === 403 && (isRateLimitResponse(headers) || /secondary rate limit/i.test(error.message)));
    if (isLimit) return new RateLimitedError(error.message, retryAfterSeconds(headers, now));
    return new GitHubApiError(error.message, error.status);
  }
  if (isGraphqlError(error)) {
    if (error.errors?.some((e) => e.type === "RATE_LIMITED")) {
      return new RateLimitedError(error.message, retryAfterSeconds(error.headers ?? {}, now));
    }
    return new GitHubApiError(error.message, 200);
  }
  return error;
}

function isRateLimitResponse(headers: Record<string, string | number | undefined>): boolean {
  return headers["retry-after"] !== undefined || String(headers["x-ratelimit-remaining"]) === "0";
}

function retryAfterSeconds(headers: Record<string, string | number | undefined>, now: DateTime): number {
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  const resetEpochSeconds = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0) {
    return Math.max(1, Math.ceil(resetEpochSeconds - now.toSeconds()));
  }
  return DEFAULT_RATE_LIMIT_RETRY_SECONDS;
}

function isRequestError(error: unknown): error is OctokitRequestError {
  return (
    error instanceof Error && error.name === "HttpError" && typeof (error as { status?: unknown }).status === "number"
  );
}

function isGraphqlError(error: unknown): error is OctokitGraphqlError {
  return error instanceof Error && error.name === "GraphqlResponseError";
}
