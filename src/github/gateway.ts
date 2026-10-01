import type { Logger } from "../core/log";
import type { Clock } from "../core/time";
import { createInstallationTokens, type GitHubAppCredentials } from "./auth";
import { createGitHubHttp, createTokenRequest } from "./client";
import { createGitHubReader } from "./reader";
import type { GitHubGateway } from "./types";
import { createDryRunGitHubWriter, createGitHubWriter } from "./writer";

export interface GitHubGatewayDeps {
  credentials: GitHubAppCredentials;
  kv: KVNamespace;
  clock: Clock;
  log: Logger;
  /** Test seam: replaces the global fetch for every GitHub call. */
  fetch?: typeof fetch;
}

export function createGitHubGateway({ credentials, kv, clock, log, fetch }: GitHubGatewayDeps): GitHubGateway {
  const tokens = createInstallationTokens({ credentials, kv, clock, request: createTokenRequest(fetch) });
  const http = createGitHubHttp({ tokens, clock, fetch });
  return { reader: createGitHubReader({ graphql: http.graphql, log }), writer: createGitHubWriter(http.request) };
}

/** Dry run keeps reads and replaces the writer with a logger. */
export function withDryRunWriter(gateway: GitHubGateway, log: Logger): GitHubGateway {
  return { reader: gateway.reader, writer: createDryRunGitHubWriter(log) };
}
