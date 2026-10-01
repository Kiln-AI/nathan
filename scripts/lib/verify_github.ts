// The checks behind scripts/verify-github.ts: a live run against GitHub with an environment's App
// credentials, closing what the research couldn't test without them (docs/setup.md, "Verify GitHub
// access"). Kept free of Node APIs so the tests run it in workerd with the real gateway over a stub.
import { deepMerge } from "../../src/core/config";
import type { GitHubHttp } from "../../src/github/client";
import { parseRepo } from "../../src/github/repo";
import type { GitHubReader, PRData } from "../../src/github/types";

export type Outcome = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  outcome: Outcome;
  lines: string[];
}

/** GitHub's GraphQL budget for an App installation (points per hour). */
export const GRAPHQL_HOURLY_POINTS = 5000;
/** Sweep cost worth a look: the hourly sweep shares the budget with every webhook-driven refresh. */
export const SWEEP_COST_BUDGET = 100;
/** Open PRs whose checks are cross-checked against their base branch's rules. */
export const IS_REQUIRED_SAMPLE_SIZE = 5;

export interface VerifyDeps {
  repos: readonly string[];
  /** Mints (or reuses) an installation token. */
  token(): Promise<unknown>;
  reader: Pick<GitHubReader, "openPullRequests" | "pullRequest">;
  /** Status check names the branch's protection and rulesets require; null when neither could be read. */
  requiredContexts(repo: string, branch: string): Promise<string[] | null>;
}

const CHECK_NAMES = { token: "App token", sweep: "Sweep", isRequired: "isRequired" } as const;

export async function verifyGitHub(deps: VerifyDeps): Promise<CheckResult[]> {
  const token = await checkToken(deps);
  if (token.outcome === "fail") {
    return [token, skipped(CHECK_NAMES.sweep, "needs a token"), skipped(CHECK_NAMES.isRequired, "needs a token")];
  }
  const sweep = await checkSweep(deps);
  if (!sweep.pullRequests) return [token, sweep.result, skipped(CHECK_NAMES.isRequired, "needs the sweep")];
  return [token, sweep.result, await checkIsRequired(deps, sweep.pullRequests)];
}

async function checkToken(deps: VerifyDeps): Promise<CheckResult> {
  try {
    await deps.token();
    return { name: CHECK_NAMES.token, outcome: "pass", lines: ["Minted an installation token."] };
  } catch (error) {
    return {
      name: CHECK_NAMES.token,
      outcome: "fail",
      lines: [message(error), "Check GITHUB_APP_ID, GITHUB_INSTALLATION_ID and that the private key is the App's."],
    };
  }
}

async function checkSweep(deps: VerifyDeps): Promise<{ result: CheckResult; pullRequests?: PRData[] }> {
  const name = CHECK_NAMES.sweep;
  let sweep: Awaited<ReturnType<VerifyDeps["reader"]["openPullRequests"]>>;
  try {
    sweep = await deps.reader.openPullRequests(deps.repos);
  } catch (error) {
    return { result: { name, outcome: "fail", lines: [message(error)] } };
  }

  const lines = deps.repos
    .filter((repo) => !sweep.missingRepos.includes(repo))
    .map((repo) => {
      const prs = sweep.pullRequests.filter((pr) => pr.repo === repo);
      const drafts = prs.filter((pr) => pr.isDraft).length;
      return `${repo}: ${prs.length} open PRs (${drafts} drafts)`;
    });
  const share = ((sweep.cost / GRAPHQL_HOURLY_POINTS) * 100).toFixed(1);
  lines.push(`Cost: ${sweep.cost} points per sweep (${share}% of the ${GRAPHQL_HOURLY_POINTS}-point hourly budget).`);

  let outcome: Outcome = "pass";
  if (sweep.cost > SWEEP_COST_BUDGET) {
    outcome = "warn";
    lines.push(`That's over the ${SWEEP_COST_BUDGET}-point budget; consider fewer repos or a smaller page size.`);
  }
  if (sweep.missingRepos.length > 0) {
    outcome = "fail";
    lines.push(
      `Not returned: ${sweep.missingRepos.join(", ")}. Add them to the App's installation (Configure → Repository access), or fix the name in nathan.config.ts.`,
    );
  }
  return { result: { name, outcome, lines }, pullRequests: sweep.pullRequests };
}

/**
 * The research couldn't confirm that `isRequired` works with an installation token. The single-PR
 * query asks it for every check, so its answers are compared with the base branch's rules, read
 * independently of `isRequired`.
 */
async function checkIsRequired(deps: VerifyDeps, swept: readonly PRData[]): Promise<CheckResult> {
  const name = CHECK_NAMES.isRequired;
  const hasFailure = (pr: PRData) => pr.checks.some((check) => check.outcome === "failure");
  const sample = swept
    .filter((pr) => !pr.isDraft && pr.checks.length > 0)
    .sort((a, b) => Number(hasFailure(b)) - Number(hasFailure(a)))
    .slice(0, IS_REQUIRED_SAMPLE_SIZE);
  if (sample.length === 0) {
    return skipped(name, "No open, non-draft PR has CI checks. Open one in a tracked repo and run this again.");
  }

  const rules = new Map<string, Promise<string[] | null>>();
  const rulesFor = (repo: string, branch: string) => {
    const key = `${repo}@${branch}`;
    let lookup = rules.get(key);
    if (!lookup) {
      lookup = deps.requiredContexts(repo, branch);
      rules.set(key, lookup);
    }
    return lookup;
  };

  const lines: string[] = [];
  const problems: string[] = [];
  let confirmed = false;
  for (const { repo, number } of sample) {
    let pr: PRData | null;
    try {
      pr = await deps.reader.pullRequest(repo, number);
    } catch (error) {
      return { name, outcome: "fail", lines: [...lines, ...problems, `${repo}#${number}: ${message(error)}`] };
    }
    if (!pr) continue;

    const branchRules = await rulesFor(repo, pr.baseRef);
    const required = pr.checks.filter((check) => check.required === true).map((check) => check.name);
    const notRequired = pr.checks.filter((check) => check.required === false).map((check) => check.name);
    lines.push(
      `${repo}#${number} (base ${pr.baseRef}): required [${required.join(", ")}], not required [${notRequired.join(", ")}]; branch rules require ${branchRules ? `[${branchRules.join(", ")}]` : "(couldn't read them)"}`,
    );

    for (const check of pr.checks) {
      if (check.required === null) problems.push(`${repo}#${number}: isRequired wasn't answered for "${check.name}".`);
      else if (check.required === false && branchRules?.includes(check.name)) {
        problems.push(`${repo}#${number}: the branch requires "${check.name}", but isRequired says it isn't required.`);
      }
    }
    if (required.length > 0) confirmed = true;
  }

  if (problems.length > 0) {
    return {
      name,
      outcome: "fail",
      lines: [
        ...lines,
        ...problems,
        "Nathan would treat required CI failures as optional. Don't launch until this passes.",
      ],
    };
  }
  if (!confirmed) {
    return {
      name,
      outcome: "warn",
      lines: [
        ...lines,
        "No sampled check is required, so this can't confirm isRequired sees required checks. If a repo requires CI, rerun once a PR there has run it.",
      ],
    };
  }
  return { name, outcome: "pass", lines };
}

function skipped(name: string, reason: string): CheckResult {
  return { name, outcome: "skip", lines: [reason] };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LABELS: Record<Outcome, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export function formatResults(results: readonly CheckResult[]): string {
  return results
    .flatMap((result) => [`${LABELS[result.outcome]}  ${result.name}`, ...result.lines.map((line) => `      ${line}`)])
    .join("\n");
}

export function hasFailures(results: readonly CheckResult[]): boolean {
  return results.some((result) => result.outcome === "fail");
}

// ---- Branch rules ---------------------------------------------------------------------------

const BRANCH_PROTECTION_QUERY = `query BranchProtection($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { refUpdateRule { requiredStatusCheckContexts } } }
}`;

interface BranchProtectionData {
  repository: {
    ref: { refUpdateRule: { requiredStatusCheckContexts: (string | null)[] | null } | null } | null;
  } | null;
}

interface BranchRule {
  type: string;
  parameters?: { required_status_checks?: { context: string }[] };
}

/**
 * Reads a branch's required status checks with the App's read-only access: classic branch
 * protection through GraphQL `refUpdateRule`, and rulesets through REST (Metadata: read). Either
 * may be unreadable; the result is null only when both are.
 */
export function createRequiredContextsLookup(
  http: Pick<GitHubHttp, "graphql" | "request">,
): VerifyDeps["requiredContexts"] {
  return async (repo, branch) => {
    const { owner, name } = parseRepo(repo);
    const [classic, rulesets] = await Promise.all([
      http
        .graphql<BranchProtectionData>(BRANCH_PROTECTION_QUERY, { owner, name, ref: `refs/heads/${branch}` })
        .then(({ data, errors }) => {
          if (errors.length > 0) return null;
          const contexts = data?.repository?.ref?.refUpdateRule?.requiredStatusCheckContexts ?? [];
          return contexts.filter((context): context is string => context !== null);
        })
        .catch(() => null),
      http
        .request("GET /repos/{owner}/{repo}/rules/branches/{branch}", { owner, repo: name, branch, per_page: 100 })
        .then(({ data }) =>
          (data as unknown as BranchRule[])
            .filter((rule) => rule.type === "required_status_checks")
            .flatMap((rule) => rule.parameters?.required_status_checks?.map((check) => check.context) ?? []),
        )
        .catch(() => null),
    ]);
    if (classic === null && rulesets === null) return null;
    return [...new Set([...(classic ?? []), ...(rulesets ?? [])])];
  };
}

// ---- Script plumbing ------------------------------------------------------------------------

/** `KEY=value` lines, as in wrangler's `.dev.vars`: `#` comments and blank lines skipped, one level of quotes stripped. */
export function parseDevVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    vars[key] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return vars;
}

/** `pr_management.repos` for an environment, whether or not the feature is enabled yet. */
export function reposFromConfig(raw: unknown, envName: string): string[] {
  const { environments = {}, ...base } = raw as { environments?: Record<string, unknown> };
  const overlay = environments[envName];
  if (!isRecord(overlay)) {
    throw new Error(`nathan.config.ts has no "${envName}" environment (have: ${Object.keys(environments).join(", ")})`);
  }
  const merged = deepMerge(base, overlay) as { features?: { pr_management?: { repos?: unknown } } };
  const repos = merged.features?.pr_management?.repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error("nathan.config.ts lists no pr_management.repos; pass --repo owner/name");
  }
  return repos.map(String);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enough of a KVNamespace for the installation-token cache outside Workers. */
export function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  const kv = {
    async get(key: string, type?: "text" | "json") {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
  return kv as unknown as KVNamespace;
}
