// Public surface of the GitHub gateway: everything a feature may use. Features import only this
// file; the Octokit client, App auth and webhook route are wired by src/core/app.ts.

export { GitHubApiError, RateLimitedError } from "./errors";
export { parseRepo, type RepoName } from "./repo";
export type {
  Check,
  CheckOutcome,
  GitHubGateway,
  GitHubReader,
  GitHubWriter,
  Mergeable,
  PRData,
  PRHistory,
  PRState,
  Review,
  ReviewState,
  SweepResult,
} from "./types";
export {
  GITHUB_EVENTS,
  type GitHubEventName,
  type GitHubRegistry,
  type GitHubWebhookEvent,
  type GitHubWebhookHandler,
} from "./webhooks";
