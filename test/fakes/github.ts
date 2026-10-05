import type { DateTime } from "luxon";
import type { GitHubGateway, GitHubReader, GitHubWriter, PRData, PRHistory, SweepResult } from "../../src/github";

export interface ReviewerRequest {
  repo: string;
  number: number;
  logins: string[];
}

export interface LabelRequest {
  repo: string;
  number: number;
  labels: string[];
}

/**
 * `GitHubGateway` over in-memory fixtures. Writes are recorded and, like GitHub, add the logins to
 * the PR's pending reviewers and the labels to its labels, so a refresh afterwards sees them.
 */
export class FakeGitHub implements GitHubGateway {
  readonly prs: PRData[] = [];
  readonly history: PRHistory[] = [];
  readonly reviewerRequests: ReviewerRequest[] = [];
  readonly labelRequests: LabelRequest[] = [];
  /** Repos the sweep reports as missing. */
  readonly missingRepos = new Set<string>();
  private failure: Error | undefined;

  constructor(prs: PRData[] = []) {
    this.prs.push(...prs);
  }

  /** Makes every call throw `error` until `succeed()` is called. */
  fail(error: Error = new Error("github is down")): void {
    this.failure = error;
  }

  succeed(): void {
    this.failure = undefined;
  }

  /** Adds or replaces a PR fixture (matched on repo and number). */
  upsert(pr: PRData): void {
    const index = this.prs.findIndex((p) => p.repo === pr.repo && p.number === pr.number);
    if (index === -1) this.prs.push(pr);
    else this.prs[index] = pr;
  }

  readonly reader: GitHubReader = {
    openPullRequests: async (repos): Promise<SweepResult> => {
      this.check();
      return {
        pullRequests: this.prs.filter((pr) => pr.state === "open" && repos.includes(pr.repo)),
        missingRepos: repos.filter((repo) => this.missingRepos.has(repo)),
        cost: 1,
      };
    },
    pullRequest: async (repo, number) => {
      this.check();
      return this.prs.find((pr) => pr.repo === repo && pr.number === number) ?? null;
    },
    recentPullRequests: async (repos, since: DateTime) => {
      this.check();
      return this.history.filter((pr) => repos.includes(pr.repo) && pr.updatedAt >= since);
    },
    openPullRequestsForCommit: async (repo, sha) => {
      this.check();
      return this.prs
        .filter((pr) => pr.repo === repo && pr.state === "open" && pr.headSha === sha)
        .map((pr) => pr.number);
    },
  };

  readonly writer: GitHubWriter = {
    requestReviewers: async (repo, number, logins) => {
      this.check();
      this.reviewerRequests.push({ repo, number, logins: [...logins] });
      const pr = this.prs.find((p) => p.repo === repo && p.number === number);
      if (pr) {
        const added = logins.filter((login) => !pr.pendingReviewers.includes(login));
        this.upsert({ ...pr, pendingReviewers: [...pr.pendingReviewers, ...added] });
      }
    },
    addLabels: async (repo, number, labels) => {
      this.check();
      if (labels.length === 0) return;
      this.labelRequests.push({ repo, number, labels: [...labels] });
      const pr = this.prs.find((p) => p.repo === repo && p.number === number);
      if (pr) {
        const has = new Set(pr.labels.map((label) => label.toLowerCase()));
        const added = labels.filter((label) => !has.has(label.toLowerCase()));
        this.upsert({ ...pr, labels: [...pr.labels, ...added] });
      }
    },
  };

  private check(): void {
    if (this.failure) throw this.failure;
  }
}
