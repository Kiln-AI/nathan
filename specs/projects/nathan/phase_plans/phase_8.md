---
status: complete
---

# Phase 8: Launch readiness

## Overview

Everything needed to take Nathan live, short of the live steps themselves (which need Slack, GitHub and Cloudflare credentials):

- `docs/setup.md` becomes the complete, ordered runbook: Cloudflare resources, team config, Slack app and GitHub App per environment, secrets and key conversion, verifying GitHub access, deploying, inviting Nathan to the channels, then the staging dry-run checklist and the production cutover checklist (including retiring the Workflow Builder "Request PR" workflow).
- `scripts/verify-github.ts` (`npm run verify:github -- <env>`) is a live check, run from a laptop with an environment's GitHub App secrets, that closes the research's open questions before launch:
  1. **App token**: the credentials mint an installation token (PKCS#8 key, App ID and installation ID all right).
  2. **Sweep**: the real sweep query reads every configured repo (none missing, i.e. the App is installed on each), and reports its GraphQL `rateLimit.cost` against the 5,000-point hourly budget (warning above a per-sweep budget).
  3. **`isRequired`**: for a sample of open PRs with CI, the single-PR query (which asks `isRequired` for every check) is cross-checked against the base branch's required checks, read independently from classic branch protection (GraphQL `refUpdateRule`) and rulesets (REST `rules/branches`). A check the branch requires but `isRequired` reports as not required fails the run: that's the "installation tokens can't see required checks" failure the research couldn't rule out.

## Steps

1. **`src/github/auth.ts`**: split the token-minting part out of `readGitHubAppCredentials`, so the script needn't ask for the webhook secret:
   ```ts
   export type GitHubAppAuth = Pick<GitHubAppCredentials, "appId" | "privateKey" | "installationId">;
   /** The secrets needed to mint installation tokens. Throws when one is missing or malformed. */
   export function readGitHubAppAuth(env: object): GitHubAppAuth;
   export function readGitHubAppCredentials(env: object): GitHubAppCredentials; // = readGitHubAppAuth + webhook secret
   ```

2. **`scripts/lib/verify_github.ts`** (pure orchestration, runs in workerd tests and in Node):
   ```ts
   export type Outcome = "pass" | "warn" | "fail" | "skip";
   export interface CheckResult { name: string; outcome: Outcome; lines: string[] }
   /** Sweep cost above this is worth a look: the hourly sweep plus refreshes share 5,000 points/hour. */
   export const SWEEP_COST_BUDGET = 100;
   export const GRAPHQL_HOURLY_POINTS = 5000;
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
   export async function verifyGitHub(deps: VerifyDeps): Promise<CheckResult[]>;
   export function formatResults(results: readonly CheckResult[]): string;
   export function hasFailures(results: readonly CheckResult[]): boolean;

   /** Reads a branch's required status checks with read-only access: classic protection and rulesets. */
   export function createRequiredContextsLookup(http: Pick<GitHubHttp, "graphql" | "request">): VerifyDeps["requiredContexts"];
   /** `KEY=value` lines, as in wrangler's `.dev.vars` (quotes stripped, `#` comments skipped). */
   export function parseDevVars(text: string): Record<string, string>;
   /** `pr_management.repos` for an environment, whether or not the feature is enabled yet. */
   export function reposFromConfig(raw: unknown, envName: string): string[];
   /** A KVNamespace stand-in for the token cache outside Workers. */
   export function memoryKv(): KVNamespace;
   ```
   - Token: fail → the other checks are `skip` ("needs a token").
   - Sweep: `fail` when repos are missing (with the "Configure → Repository access" hint); lines give PR counts per repo (drafts separately) and the cost with its share of the hourly budget; `warn` when the cost exceeds `SWEEP_COST_BUDGET`. Sweep failure → isRequired `skip`.
   - isRequired: candidates are open non-draft PRs with checks, failing-check PRs first, at most `IS_REQUIRED_SAMPLE_SIZE`. None → `skip` (open a PR with CI and rerun). Per PR, re-read with `pullRequest`, look up its base branch's required contexts (cached per repo and branch), and print required / not required / branch rules. `fail` if a check is still unresolved (`required: null`) or the branch requires a check `isRequired` says isn't; `pass` when at least one check came back required with no mismatch; otherwise `warn` (nothing required on the sampled PRs, so the check can't confirm it).

3. **`scripts/verify-github.ts`** (Node entry, run with `tsx`): parse `<env>` and repeated `--repo owner/name` overrides; read `.dev.vars.<env>` (or `.dev.vars`) under `process.env`; `readGitHubAppAuth`; build the real token cache (`createInstallationTokens` over `memoryKv()`), `createGitHubHttp`, `createGitHubReader` with a silent logger; print `formatResults`; exit code 1 on failure. Bad credentials print a failed "App credentials" check.

4. **`package.json`**: `"verify:github": "tsx scripts/verify-github.ts"`.

5. **`docs/setup.md`**: complete it in launch order:
   - Overview with the order of steps and the per-environment checklist of names (Worker, D1, KV, queues, Slack app, GitHub App).
   - Cloudflare resources (existing) plus the GitHub Actions secrets.
   - Team config: users mapping (how to find Slack IDs), PR channel, admin channel, test channel, triager, repos, enabling `pr_management`; staging overlay.
   - Slack app and GitHub App (existing, light edits).
   - **Verify GitHub access**: `.dev.vars.<env>`, `npm run verify:github -- <env>`, what each check means and what to do on failure.
   - Deploying (existing).
   - **Staging dry-run checklist**: deploy, `/healthz`, Slack challenge, Home tab, `/nathan-staging help` and `prs`, shortcut and modal validation errors, a scratch PR through request → review → merge (cards and handoffs in the test channel with `[dry-run → …]` labels, no GitHub write), reminders/draft nudges observed, the daily report at its time, admin channel errors, DLQ empty.
   - **Production cutover checklist**: pre-flight (config PR merged with real IDs, `pr_management.enabled`, verify script green on production, secrets set), the deploy, smoke checks, the first sweep's backfill burst and draft DMs, announcing to the team, retiring the Workflow Builder workflow (unpublish, remove its bookmark/shortcut), and rollback (`enabled: false` or `wrangler rollback`).

6. **`README.md`**: mention `npm run verify:github`.

## Tests

`test/scripts/verify_github.test.ts`:
- verifyGitHub, token failure: token fails, sweep and isRequired skipped, `hasFailures` true.
- verifyGitHub, sweep: missing repo fails with the installation hint; PR counts and cost share reported; cost over budget warns.
- verifyGitHub, sweep throws: sweep fails, isRequired skipped.
- verifyGitHub, isRequired pass: a required check that the branch rules list passes; failing-check PRs are sampled first; sample size capped; lookups cached per repo/branch.
- verifyGitHub, isRequired fail: branch requires `test` but `isRequired` says false → fail naming the check; an unresolved (`null`) check fails.
- verifyGitHub, isRequired warn: no required checks on the sampled PRs → warn; rules unreadable is shown.
- verifyGitHub, isRequired skip: no open non-draft PR with checks → skip.
- createRequiredContextsLookup: unions `refUpdateRule.requiredStatusCheckContexts` and ruleset `required_status_checks` contexts (deduped); one source failing still returns the other; both failing → null. Uses `createGitHubHttp` over the stubbed GitHub API.
- formatResults/hasFailures: outcome labels and indentation; warn/skip aren't failures.
- parseDevVars: comments, blank lines, quotes, `=` in values, `\n` kept literal.
- reposFromConfig: environment overlay wins; disabled feature still yields repos; missing section or bad env throws.
- memoryKv: json get/put/delete round trip.
- `readGitHubAppAuth` (in `test/github/auth.test.ts`): reads the three secrets without a webhook secret.
