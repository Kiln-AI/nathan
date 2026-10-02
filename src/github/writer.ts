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
    // A PR is an issue to the labels API. Adding (unlike setting) keeps the PR's other labels and
    // creates a label the repo doesn't have yet; re-adding one it already has is a no-op.
    async addLabels(repo, number, labels) {
      if (labels.length === 0) return;
      const { owner, name } = parseRepo(repo);
      await request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner,
        repo: name,
        issue_number: number,
        labels: [...labels],
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
    async addLabels(repo, number, labels) {
      if (labels.length === 0) return;
      log.info("dry run: would add labels", { repo, number, labels: [...labels] });
    },
  };
}
