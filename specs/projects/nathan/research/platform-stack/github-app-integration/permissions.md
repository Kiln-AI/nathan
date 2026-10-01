# GitHub App Permissions for Nathan

How this was researched: `docs.github.com` was blocked by the sandbox egress proxy. I read the **source of the GitHub docs site** instead (`github/docs` repo, `main` branch, sparse clone on 2026-10-01). The per-endpoint permission data that renders the official pages lives in:

- `src/github-apps/data/fpt-2022-11-28/server-to-server-permissions.json`: the data behind [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps). "server-to-server" means installation access tokens.
- `src/rest/data/fpt-2022-11-28/*.json` (`progAccess.permissions`): the "Fine-grained access tokens" box on each REST endpoint page.
- `src/webhooks/data/fpt/*.json`: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).
- `src/graphql/data/fpt/schema.docs.graphql`: the public GraphQL schema.

Everything below is quoted from those files unless marked **[inference]** or **[community report]**.

How to read `progAccess.permissions`: it is a list of permission sets. The docs renderer (`src/rest/components/RestAuth.tsx`) prints "The fine-grained token must have **at least one of** the following permission sets" when the list has more than one entry. So two entries mean OR, not AND.

---

## 1. Minimum permission matrix (REST, installation token)

| Nathan need | Endpoint(s) | Permission (from docs data) |
|---|---|---|
| List open PRs | `GET /repos/{owner}/{repo}/pulls` | **Pull requests: read** |
| Get one PR (incl. `mergeable`, `mergeable_state`) | `GET /repos/{owner}/{repo}/pulls/{pull_number}` | **Pull requests: read** *or* Contents: read (two permission sets, OR) |
| Reviews | `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | **Pull requests: read** |
| Requested reviewers | `GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` | **Pull requests: read** |
| Timeline (ready_for_review / convert_to_draft times) | `GET /repos/{owner}/{repo}/issues/{issue_number}/timeline` | Issues: read **or** Pull requests: read |
| Check runs for a commit | `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`, `.../check-suites` | **Checks: read** |
| Commit statuses | `GET /repos/{owner}/{repo}/commits/{ref}/status`, `.../statuses` | **Commit statuses: read** |
| Required checks: **rulesets** | `GET /repos/{owner}/{repo}/rules/branches/{branch}` | **Metadata: read** (granted to every App automatically) |
| Required checks: **classic branch protection** | `GET /repos/{owner}/{repo}/branches/{branch}/protection` and `.../protection/required_status_checks` | **Administration: read** |
| Get a branch (has a `protection` summary) | `GET /repos/{owner}/{repo}/branches/{branch}` | Contents: read |
| Org membership (optional, see §4) | `GET /orgs/{org}/members/{username}`, `GET /orgs/{org}/memberships/{username}`, `GET /orgs/{org}/members` | **Members (organization): read** |
| Request reviewers | `POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` | **Pull requests: write** |
| Remove requested reviewers | `DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` | **Pull requests: write** |
| Mark draft ready for review | GraphQL only: `markPullRequestReadyForReview` | Not documented per mutation. Expected Pull requests: write, but see §3 (**possible Contents: write**) |

The description of `GET /rules/branches/{branch}` (verbatim): "Returns all active rules that apply to the specified branch. The branch does not need to exist; rules that would apply to a branch with that name will be returned. All active rules that apply will be returned, regardless of the level at which they are configured (e.g. repository or organization). Rules in rulesets with "evaluate" or "disabled" enforcement statuses are not returned."

The description of `POST .../requested_reviewers` (verbatim): "Requests reviews for a pull request from a given set of users and/or teams. This endpoint triggers notifications. Creating content too quickly using this endpoint may result in secondary rate limiting." Documented status codes: `201`, `403`, `422` "Unprocessable Entity if user is not a collaborator", `503`. The REST POST is **additive**. It never removes existing requests, which matches spec §4.3 ("it never removes anyone").

The description of `GET .../requested_reviewers` (verbatim): "Once a requested reviewer submits a review, they are no longer considered a requested reviewer. Their review will instead be returned by the List reviews for a pull request operation." This matters for rules 6 and 9 of the state model.

There is no REST path to un-draft a PR. The `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` body parameters are exactly `title, body, state, base, maintainer_can_modify`, with no `draft` (from `pulls.json`). So ready-for-review requires GraphQL.

### Recommended App permission set

| Permission | Level | Why |
|---|---|---|
| Metadata (repo) | read | Mandatory for all Apps. Also covers the rulesets "rules for branch" endpoint |
| Pull requests (repo) | **write** | Read all PR/review data. Write for the reviewer add/remove and ready-for-review allow-list |
| Checks (repo) | read | Check runs and suites, and the `check_run`/`check_suite` webhooks |
| Commit statuses (repo) | read | Legacy statuses, and the `status` webhook |
| Members (org) | read, **optional** | Only if Nathan uses org membership (spec §4.1 classifies by the *user directory*, so V1 may not need it) |
| Administration (repo) | read, **avoid** | Only needed for the classic branch-protection REST endpoints. The GraphQL `isRequired` route avoids it (see state-model doc) |
| Contents (repo) | **avoid unless §3 forces it** | Grants read access to code. Write would be a large privilege expansion |

Webhook subscriptions also depend on these permissions. See [webhooks.md](./webhooks.md): `pull_request`, `pull_request_review` and `pull_request_review_thread` need Pull requests read; `check_run` and `check_suite` need Checks read; `status` needs Commit statuses read; `branch_protection_rule` and `repository_ruleset` need **Administration read** (so Nathan should *not* subscribe to them).

---

## 2. GraphQL and permissions

GitHub Apps calling GraphQL with an installation token are limited by the same permissions. The GraphQL schema does not document per-field permissions, so mapping GraphQL fields to permissions is **[inference]** from the REST equivalents:

- `PullRequest` fields (`isDraft`, `mergeable`, `mergeStateStatus`, `reviewRequests`, `latestOpinionatedReviews`, `reviews`, `timelineItems`): Pull requests: read.
- `Commit.statusCheckRollup.contexts` (`CheckRun`, `StatusContext`): Checks read and Commit statuses read respectively.
- `CheckRun.isRequired(pullRequestNumber:)` / `StatusContext.isRequired(...)`: a third-party implementation reports it "needs only ordinary repository read access" and "resolves classic branch protection and rulesets together" ([gkalyan/firstmate#2](https://github.com/gkalyan/firstmate/pull/2), Sept 2026). **This was not verified with an App installation token.** Test it before relying on it (see Open Questions in [summary.md](./summary.md)).
- `Ref.refUpdateRule`: the schema says verbatim "Branch protection rules that are viewable by non-admins". Its `RefUpdateRule.requiredStatusCheckContexts: [String]` is "List of required status check contexts that must pass for commits to be accepted to matching branches." This is a no-Administration fallback for classic protection. **[inference]** It probably covers classic protection only, not rulesets. Unverified.

---

## 3. `markPullRequestReadyForReview`: the permission caveat

Schema (verbatim): `markPullRequestReadyForReview(input: MarkPullRequestReadyForReviewInput!)`, "Marks a pull request ready for review." The input is `{ pullRequestId: ID!, clientMutationId }`, so you need the PR's GraphQL node ID (`node_id` in REST payloads, `id` in GraphQL).

GitHub does not document which App permission this mutation needs. Community reports:

- [cli/cli discussion #6924](https://github.com/cli/cli/discussions/6924) (2023-01-27): a GitHub App token with `actions: read, contents: read, pull_requests: write` got `Resource not accessible by integration` from `gh pr ready`. mislav (GitHub CLI maintainer) replied on 2023-01-30: "I'm guessing that you must have `contents: write` too". A follow-up on 2024-02-14 says "This appears to be the case and is very unfortunate. Application developers shouldn't need `contents:write` permissions to mark an existing pull request ready for review."
- [community discussion #41631](https://github.com/orgs/community/discussions/41631) (2022-12): an App with PR, Issues *and* Contents read/write still got FORBIDDEN. That report is inconclusive; for example, the permissions may not have been re-accepted on the installation.
- [alexbmontiel/ready-for-review-workflow](https://github.com/alexbmontiel/ready-for-review-workflow) claims the Actions `GITHUB_TOKEN` is blocked from this mutation and uses a fine-grained PAT with "Pull requests: Read and write".

**Assessment:** it is uncertain whether Pull requests: write alone is enough for an App. The only signal (2023–24, unofficial) says Contents: write may also be required. That conflicts with spec §3.4's "narrowest workable permissions". Options:

1. Test on a scratch repo with `pull_requests: write` only, before granting more.
2. If Contents: write turns out to be required: (a) accept it, and use **token down-scoping** (below) so only the ready-for-review code path ever holds a contents-write token; or (b) drop the auto-ready feature and have the modal tell the author to click "Ready for review" themselves (spec §4.3 already rejects submit when the checkbox is off).

---

## 4. Classifying external contributors

Spec §4.1 classifies PRs by the user directory (team = mapped GitHub login; bots = configured list; everything else = OSS). That needs **no GitHub permission**. If org membership is ever wanted as a signal:

- `author_association` (REST payloads; `authorAssociation` in GraphQL, enum `CommentAuthorAssociation`: `COLLABORATOR, CONTRIBUTOR, FIRST_TIMER, FIRST_TIME_CONTRIBUTOR, MANNEQUIN, MEMBER, NONE, OWNER`) **under-reports private org members**. Two independent 2026 reports say private members show as `CONTRIBUTOR`. GitHub "only reveals a private membership to a caller whose credential carries `members:read`" ([HarperFast/harper#2773](https://github.com/HarperFast/harper/pull/2773), Sept 2026; [xwiki/xwiki-commons#2020](https://github.com/xwiki/xwiki-commons/pull/2020)). The same harper PR reports that minting a token with `members:read` and calling `GET /orgs/{org}/memberships/{login}` resolves it correctly. Webhook payloads also carry a snapshot that "can go stale".
- The reliable check is `GET /orgs/{org}/members/{username}` (204 = member, 404 = not), with Members: read.
- Recommendation: stick with the spec's user-directory rule and do not request Members. If you want a safety net, `authorAssociation in (MEMBER, OWNER)` can only *promote* a PR to "team-ish" status, never demote one.

---

## 5. Enforcing the write allow-list at the token level

From the docs source (`data/reusables/apps/generate-installation-access-token.md`), verbatim:

- "Optionally, use the `permissions` body parameter to specify the permissions that the installation access token should have. If `permissions` is not specified, the installation access token will have all of the permissions that were granted to the app. The installation access token cannot be granted permissions that the app was not granted."
- "Optionally, you can use the `repositories` or `repository_ids` body parameters to specify individual repositories that the installation access token can access. ... You can list up to 500 repositories."
- "The installation access token will expire after 1 hour."

`@octokit/auth-app` exposes this: `auth({ type: "installation", installationId, permissions: { pull_requests: "read", checks: "read", statuses: "read", metadata: "read" } })` (README option `permissions`: "An object where keys are the permission name and the value is either "read" or "write""). The library caches tokens per installation, permission set and repository set.

**[inference] Design suggestion:** mint read-only tokens for the sweep and the webhook handlers. Only the GitHub write module (request/remove reviewer, mark ready) mints a `pull_requests: write` token. This turns the spec's code-level allow-list into a credential-level control too. Dry-run mode can simply never mint a write token.
