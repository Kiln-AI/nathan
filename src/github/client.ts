import { Octokit } from "@octokit/core";
import type { Clock } from "../core/time";
import type { InstallationTokens } from "./auth";
import { RateLimitedError, toGitHubError } from "./errors";

// The Octokit instance never leaves src/github/: features reach GitHub only through the typed
// reader and the allow-listed writer (architecture §8).

export interface GraphqlError {
  type?: string;
  message: string;
  path?: (string | number)[];
}

/** GraphQL can answer with partial data plus errors (e.g. one aliased repo NOT_FOUND). */
export interface GraphqlResult<T> {
  data: T | null;
  errors: GraphqlError[];
}

export type ReadOnlyGraphql = <T>(query: string, variables?: Record<string, unknown>) => Promise<GraphqlResult<T>>;

export interface GitHubHttp {
  graphql: ReadOnlyGraphql;
  /** Authenticated REST. The writer uses it, and scripts/verify-github.ts for one read (branch rules). */
  request: Octokit["request"];
}

export interface GitHubHttpDeps {
  tokens: InstallationTokens;
  clock: Clock;
  /** Test seam. */
  fetch?: typeof fetch;
}

export function createGitHubHttp({ tokens, clock, fetch }: GitHubHttpDeps): GitHubHttp {
  const octokit = new Octokit({ userAgent: "nathan", request: fetch ? { fetch } : {} });
  octokit.hook.wrap("request", async (request, options) => {
    try {
      options.headers.authorization = `token ${await tokens.get()}`;
      return await request(options);
    } catch (error) {
      if ((error as { status?: unknown }).status === 401) await tokens.invalidate();
      throw toGitHubError(error, clock.now());
    }
  });

  return {
    request: octokit.request,
    graphql: async <T>(query: string, variables: Record<string, unknown> = {}) => {
      assertReadOnly(query);
      try {
        return { data: await octokit.graphql<T>(query, variables), errors: [] };
      } catch (error) {
        const partial = error as { name?: string; data?: T; errors?: GraphqlError[] };
        if (partial.name !== "GraphqlResponseError") throw error;
        const mapped = toGitHubError(error, clock.now());
        if (mapped instanceof RateLimitedError) throw mapped;
        return { data: partial.data ?? null, errors: partial.errors ?? [] };
      }
    },
  };
}

/** The reader may only query. Mutations go through the writer's REST allow-list. */
export function assertReadOnly(query: string): void {
  if (/\bmutation\b/i.test(query)) throw new Error("GitHub reader queries must not contain a mutation");
}

/** An unauthenticated client, used only to mint installation tokens. */
export function createTokenRequest(fetch?: typeof globalThis.fetch): Octokit["request"] {
  return new Octokit({ userAgent: "nathan", request: fetch ? { fetch } : {} }).request;
}
