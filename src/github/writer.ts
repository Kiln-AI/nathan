import type { Logger } from "../core/log";
import type { GitHubHttp } from "./client";
import { parseRepo } from "./repo";
import type { GitHubWriter } from "./types";

/**
 * The only code that writes to GitHub (spec §3.4). REST, not GraphQL: REST adds reviewers, while
 * GraphQL `requestReviews` replaces them unless `union: true`. GitHub answers 422 when a login
 * isn't a collaborator on the repo.
 */
export function createGitHubWriter(request: GitHubHttp["request"]): GitHubWriter {
  return {
    async requestReviewers(repo, number, logins) {
      if (logins.length === 0) return;
      const { owner, name } = parseRepo(repo);
      await request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        owner,
        repo: name,
        pull_number: number,
        reviewers: [...logins],
      });
    },
  };
}

/** Dry run: GitHub is never written to; the intended write is logged instead. */
export function createDryRunGitHubWriter(log: Logger): GitHubWriter {
  return {
    async requestReviewers(repo, number, logins) {
      log.info("dry run: would request reviewers", { repo, number, logins: [...logins] });
    },
  };
}
