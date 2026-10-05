# Setting up Nathan

One-time setup for Nathan's two environments, `staging` and `production`, and the launch runbook. Each environment has its own Cloudflare resources, Slack app and GitHub App, because a Slack app and a GitHub App each have exactly one request URL.

Do the steps in order, for **staging first**. Run the [staging dry-run checklist](#staging-dry-run-checklist), then repeat steps 1–7 for production and follow the [production cutover checklist](#production-cutover-checklist).

1. [Cloudflare resources](#1-cloudflare-resources)
2. [Team config](#2-team-config)
3. [Slack app](#3-slack-app)
4. [GitHub App](#4-github-app)
5. [Verify GitHub access](#5-verify-github-access)
6. [Deploy](#6-deploy)
7. [Connect and smoke-test](#7-connect-and-smoke-test)

What each environment ends up with (`<env>` is `staging` or `production`):

| Thing | Name |
|---|---|
| Worker | `nathan-<env>`, at `https://nathan-<env>.<subdomain>.workers.dev` |
| D1 database | `nathan-<env>` |
| KV namespace | `nathan-<env>` |
| Queues | `nathan-jobs-<env>` and `nathan-jobs-<env>-dlq` |
| Slack app | "Nathan" with `/nathan` (production), "Nathan (staging)" with `/nathan-staging` |
| GitHub App | "Nathan" (production), "Nathan (staging)" |
| Secrets | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET` |

## Prerequisites

- Node 22+ and npm. Run `npm ci` once.
- A Cloudflare account on the Workers Paid plan. Log in with `npx wrangler login`.
- Admin access to the Slack workspace and owner access to the GitHub org.
- `openssl` (for the GitHub App key conversion).

## Local development

- `npm run check` runs everything CI runs: lint and format check, type-check, config validation, import boundaries and tests.
- `npm test` runs the tests inside workerd (Miniflare), with a real local D1, KV and queues.
- `npm run format` fixes formatting and import order.
- Live behavior is tested on staging (see [Deploy](#6-deploy)), which runs in dry-run mode.
- `npm run dev` (`wrangler dev`) works too, with a tunnel to reach it from Slack and GitHub. It reads secrets from `.dev.vars` (git-ignored); it isn't needed for any step below.

## 1. Cloudflare resources

Create these once per environment, then paste the printed IDs into the matching `env.<env>` section of `wrangler.jsonc` (replacing the `REPLACE_WITH_*` placeholders), and merge that change.

```sh
npx wrangler d1 create nathan-<env>                # → database_id
npx wrangler kv namespace create nathan-<env>      # → KV id
npx wrangler queues create nathan-jobs-<env>
npx wrangler queues create nathan-jobs-<env>-dlq
```

`scripts/setup-cloudflare.sh <env>` does all four (reusing any that already exist) and writes the IDs into `wrangler.jsonc`.

Your `workers.dev` subdomain is shown in the Cloudflare dashboard under **Workers & Pages** (or pick a custom domain). The Worker's URL, `https://nathan-<env>.<subdomain>.workers.dev`, is fixed before the first deploy, so the apps below can point at it already.

The deploy workflows apply database migrations on every deploy. To apply them by hand:

```sh
npx wrangler d1 migrations apply DB --remote --env <env>
```

## 2. Team config

Behavior config lives in `nathan.config.ts`, reviewed by PR and validated by `npm run check:config` (CI runs it too, so a bad config can't merge). Slack users and channels are referenced by **ID**, never by name:

- a person's Slack ID: their profile → **⋮** → **Copy member ID** (`U…`)
- a channel's ID: the channel name → **About** → at the bottom (`C…`)

Fill in:

- `users`: every team member, `{ github: "<login>", slack: "U…" }`. Add `tz: "Asia/Shanghai"` only to override someone's Slack profile time zone. People missing here can't be tagged: their PRs are treated as outside contributions (owned by the triager), and they can't be picked as reviewers in the form.
- `admin.slackChannel`: where job failures and dead-lettered jobs are posted. A small private channel for whoever maintains Nathan.
- `features.pr_management`:
  - `channel`: the PR channel (`#prs`).
  - `triager`: the GitHub login that owns author-side steps of Dependabot and outside-contributor PRs. They must also be in `users`, or nobody gets tagged for those PRs.
  - `repos`: every tracked repo, `owner/name`.
  - `enabled`: leave `false` until the [production cutover](#production-cutover-checklist).
  - Optional tuning (defaults in `src/features/pr_management/config.ts`): `reminders` (thresholds and message templates), `drafts` (nudge and report ages), `report` (time and time zone, default 09:30 `America/New_York`), `botAuthors`, `wipTitlePattern`.
- `environments.staging`: `dryRun: true` and `testChannel` (a channel such as `#nathan-test`). In dry run everything Nathan would post, in any channel or DM, goes to the test channel instead.

Staging's overlay can enable `pr_management` on its own (`environments.staging.features.pr_management.enabled: true`), so it can be tested while production stays off.

## 3. Slack app

The manifests in the repo define everything (scopes, the Home tab, the "Request PR review" shortcut, the slash command and the event subscription):

- production: `slack-manifest.production.yaml` (`/nathan`)
- staging: `slack-manifest.staging.yaml` (`/nathan-staging`)

For each environment:

1. In the manifest, replace `REPLACE_WITH_WORKERS_SUBDOMAIN` with your `workers.dev` subdomain, or point the three URLs at a custom domain. All three end in `/slack/events`. Merge that change.
2. At <https://api.slack.com/apps>, choose **Create New App → From a manifest**, pick the workspace and paste the manifest. Slack may warn that the event URL isn't verified yet; that's fixed in [step 7](#7-connect-and-smoke-test).
3. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`) and, from **Basic Information**, the **Signing Secret**, and set them:
   ```sh
   npx wrangler secret put SLACK_BOT_TOKEN --env <env>
   npx wrangler secret put SLACK_SIGNING_SECRET --env <env>
   ```
   (The first `secret put` for an environment may ask to create the Worker; say yes.)

Notes:

- Bot scopes are `commands`, `chat:write`, `users:read`, `reactions:write` and `im:write`. Nathan doesn't use `chat:write.public`, so it can only post in channels it's been invited to ([step 7](#7-connect-and-smoke-test)).
- Changing scopes or events later: edit the manifest in the repo first, paste it into the app's **App Manifest** page, then reinstall the app if Slack asks.

## 4. GitHub App

Staging's App is installed on the same repos as production's; staging runs in dry run, so it only reads.

For each environment:

1. Generate a webhook secret, e.g. `openssl rand -hex 32`, and keep it for steps 2 and 6.
2. In the org's **Settings → Developer settings → GitHub Apps → New GitHub App**:
   - **Name:** "Nathan" (production) or "Nathan (staging)".
   - **Homepage URL:** the repo URL.
   - **Webhook:** active, URL `https://nathan-<env>.<subdomain>.workers.dev/github/webhooks`, and the secret from step 1.
   - **Repository permissions** (nothing else):

     | Permission | Access | Used for |
     |---|---|---|
     | Metadata | Read | Required by every App |
     | Pull requests | Read & write | Reading PRs, reviews, review requests and labels; **write is only used to request reviewers and add the `quick`, `large` and `urgent` labels** (GitHub creates a label the first time it's added) |
     | Checks | Read | CI check runs |
     | Commit statuses | Read | CI from external services (commit statuses) |
     | Contents | Read | A PR's head commit and its CI in **private** repos (public repos work without it) |

   - **Subscribe to events:** Pull request, Pull request review, Check run, Status. (Merge queues and labels need nothing more: entering and leaving a queue, and labelling or unlabelling a PR, are Pull request events, read with Pull requests read.)
   - **Where can this GitHub App be installed?** Only on this account.
3. After creating it, note the **App ID** on the App's page. Under **Private keys**, click **Generate a private key**; a `.pem` file downloads.
4. Convert the key to PKCS#8. GitHub hands out PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`), but Workers' Web Crypto only reads PKCS#8 (`-----BEGIN PRIVATE KEY-----`). Nathan refuses to start with a PKCS#1 key.
   ```sh
   openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem
   ```
5. **Install App** on the org, choosing **Only select repositories** and every repo in `pr_management.repos`. The installation ID is the number at the end of the installation's settings URL (`…/settings/installations/<id>`).
6. Set the secrets:
   ```sh
   npx wrangler secret put GITHUB_APP_ID --env <env>            # the App ID
   npx wrangler secret put GITHUB_INSTALLATION_ID --env <env>   # from step 5
   npx wrangler secret put GITHUB_WEBHOOK_SECRET --env <env>    # from step 1
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env <env> < key.pk8.pem
   ```
   Keep `key.pk8.pem` until [step 5](#5-verify-github-access) passes, then delete both `.pem` files. A lost key is replaced by generating a new one on the App's page.

Notes:

- Adding a repo to `pr_management.repos` later also needs the repo added to both Apps' installations (**Configure → Repository access**). Until then the hourly sweep reports it to the admin channel.

## 5. Verify GitHub access

`npm run verify:github` checks an environment's GitHub App live, from your machine, before Nathan depends on it. It only reads. Put the App's secrets in `.dev.vars.<env>` (git-ignored; environment variables override it):

```sh
cat > .dev.vars.<env> <<EOF
GITHUB_APP_ID=<App ID>
GITHUB_INSTALLATION_ID=<installation ID>
GITHUB_APP_PRIVATE_KEY="$(awk '{printf "%s\\n", $0}' key.pk8.pem)"
EOF
npm run verify:github -- <env>
```

It reads the repos from `nathan.config.ts` for that environment (add `--repo owner/name`, repeatable, to check others) and runs three checks. It exits non-zero if any fails.

| Check | Passes when | If it fails |
|---|---|---|
| **App token** | The App ID, installation ID and key mint an installation token. | Recheck the IDs, and that the key is this App's and converted to PKCS#8. |
| **Sweep** | The hourly sweep's query returns every configured repo. It prints open PRs per repo and the query's `rateLimit.cost`; above 100 points (2% of the 5,000-point hourly budget) it warns. | A repo "not returned" isn't in the App's installation (**Configure → Repository access**), or is misspelled. |
| **isRequired** | For up to 5 open PRs with CI, GitHub's `isRequired` answer for each check agrees with the base branch's required checks, read separately from branch protection and rulesets. | A check the branch requires came back "not required": Nathan would treat required CI failures as optional. Don't launch; raise it in the repo. |

`isRequired` reports **SKIP** when no open PR has CI, and **WARN** when none of the sampled checks is required (nothing to confirm). Neither blocks a launch, but if your repos do require checks, open a PR that runs them and rerun until it passes. Rule sets inherited from the org may not be visible to the App; the printed "branch rules" line then lists fewer checks than GitHub's merge box, which is fine as long as nothing fails.

## 6. Deploy

- **GitHub Actions secrets:** add `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts, D1, KV and Queues edit permissions) and `CLOUDFLARE_ACCOUNT_ID` to the repo's `staging` and `production` environments (**Settings → Environments**).
- **Production** deploys on every push to `main` (`.github/workflows/deploy.yml`): checks, migrations, then `wrangler deploy --env production`.
- **Staging** deploys on demand: run the **Deploy staging** workflow with the branch or commit to deploy.
- Check a deploy with `curl https://nathan-<env>.<subdomain>.workers.dev/healthz`, which returns the environment and version. A 500 "Nathan failed to start" means a missing or invalid secret or config; `npx wrangler tail --env <env>` shows why.

## 7. Connect and smoke-test

Once the Worker is deployed with all six secrets:

1. **Slack:** in the app's **Event Subscriptions** page, click **Retry** next to the request URL until it shows *Verified*.
2. **GitHub:** on the App's **Advanced** tab, redeliver the first delivery (`ping`); it should get a `202`.
3. **Invite Nathan** to the channels it posts in. Production: `/invite @nathan` in the PR channel (`#prs`) and the admin channel. Staging: `/invite @nathan-staging` in the test channel.
4. Open Nathan's **Home** tab, and run `/nathan help` (`/nathan-staging help`).

## Staging dry-run checklist

Staging runs the real code against real GitHub data, but in dry run: every post and DM lands in the test channel, labelled `[dry-run → #channel]` or `[dry-run → DM @name]`, mentions are rewritten so nobody is pinged, and nothing is written to GitHub. Modals, the Home tab and `/nathan-staging` replies still go to whoever uses them.

Before starting: steps 1–7 done for staging, `npm run verify:github -- staging` passing, and `pr_management` enabled in the staging overlay and deployed.

**Wiring**

- [ ] `/healthz` returns `{"env":"staging",…}`.
- [ ] Slack's event URL is *Verified*, and GitHub's `ping` redelivery got a `202`.
- [ ] The Home tab shows Nathan's sections; `/nathan-staging help` lists `prs` and `pr_report`.

**Request PR form**

- [ ] The "Request PR review (staging)" shortcut (composer **+** → shortcuts, or search for it) opens the form within a second or two, and so does the Home tab's **Request PR** button.
- [ ] Each validation error shows inline on its field: a non-PR link, a PR in an untracked repo, a closed PR, a draft, a "WIP" title, a reviewer missing from `users`, and choosing only yourself on your own PR.
- [ ] A valid submission posts a card to the test channel, crediting you, with the note. The log lines "dry run: would request reviewers" and, with modifiers ticked, "dry run: would add labels" stand in for the GitHub writes (`npx wrangler tail --env staging`), so request the same reviewers on GitHub by hand to continue. The card shows only modifiers the PR already has as labels; add or remove one on GitHub and the card follows within a minute or two.
- [ ] Submitting the same PR again updates that card and adds a threaded reply, without a second card.

**A scratch PR's life** (in a tracked repo)

- [ ] Opening it with reviewers requested on GitHub posts one card about a minute later, attributed to the author.
- [ ] A review, a change request, a push that breaks CI and a fix each update the card within a minute or two, and the handoffs post threaded replies naming the new owner. Changes within a minute are coalesced.
- [ ] Merging it shows 🟣 on the card with a reaction, and nothing further in its thread. Closing another shows ⚫.
- [ ] A draft gets no card. Marking it ready with reviewers requested posts one.

**Scheduled work**

- [ ] The hourly sweep runs at the top of the hour: cards' ages update, and any PR that changed while webhooks were off is corrected (try one with the Worker's GitHub webhook temporarily deactivated).
- [ ] Reminders: a PR that sits past its threshold (24 working hours, 4 with `urgent`) gets a reminder reply in its card's thread. To see one sooner, deploy staging with a lowered `reminders.thresholdHours` for a day.
- [ ] Drafts older than 14 days produce `[dry-run → DM …]` nudges.
- [ ] The daily report posts at 09:30 ET on a weekday, with the Trends and People sections on Monday, and its **Request PR** button opens the form.
- [ ] `/nathan-staging prs` and the Home tab show "Waiting on you" and "Your open PRs" for someone in `users`, and instructions for someone who isn't.

**Errors**

- [ ] The admin channel has nothing unexpected (job failures and dead-lettered jobs are posted there; staging's land in the test channel).
- [ ] Cloudflare's dashboard shows the DLQ `nathan-jobs-staging-dlq` empty.

## Production cutover checklist

Production launches in two moves: first deployed with `pr_management` off, to check the wiring; then a config PR turns it on and the Workflow Builder "Request PR" workflow is retired at the same moment.

**Before the day**

- [ ] Steps 1–7 done for production with `pr_management.enabled: false`: `/healthz` returns `{"env":"production",…}`, Slack's URL is *Verified*, GitHub's `ping` got a `202`, and `/nathan help` answers.
- [ ] `npm run verify:github -- production` passes.
- [ ] Nathan is in the PR channel and the admin channel.
- [ ] The staging checklist passed on the commit that will ship.
- [ ] A config PR is ready with every team member in `users`, the real `channel`, `admin.slackChannel` and `triager`, the final `repos`, and `pr_management.enabled: true`. `npm run check:config` passes.
- [ ] The team knows the change is coming: the form is now the "Request PR review" shortcut, or the **Request PR** button on Nathan's Home tab and in the daily report.

**Cutover** (at a quiet time, not just before 09:30 ET)

- [ ] Merge the config PR; the **Deploy production** workflow deploys it. Check `/healthz` shows the new version.
- [ ] Retire the old workflow: in Slack, **Tools → Workflow Builder**, open the "Request PR" workflow and unpublish it (or turn it off). Remove the channel bookmark or pinned link that started it from `#prs`.
- [ ] Post in `#prs` how to request a review now, and pin it.

**The first hours**

- [ ] **The first sweep backfills cards** at the next top of the hour: one card for every open, non-draft PR with reviewers requested, including PRs the old workflow already posted. Expect that burst in `#prs`.
- [ ] **Old drafts get one DM each:** drafts older than 14 days are nudged on the first sweep (once, however old).
- [ ] Reminders don't start yet: staleness is measured from when Nathan first saw each PR, so the first reminders come one threshold (24 working hours) after launch.
- [ ] The first daily report, the next weekday at 09:30 ET, has no previous report to compare against, so it shows no change in the open count. The Needs attention section fills in once reminders start.
- [ ] Request one real review through the form and watch its card and handoffs.
- [ ] The admin channel stays quiet, and `nathan-jobs-production-dlq` stays empty.

**Rollback**

- Turning `pr_management.enabled` back to `false` (config PR, deployed on merge) stops all PR behavior and leaves existing cards as they are. Re-publish the old workflow meanwhile.
- `npx wrangler rollback --env production` returns to the previous Worker version immediately, without waiting for CI. Migrations are backward compatible, so the previous version runs on the current database.

## Operations

- **Add a person:** add them to `users` in `nathan.config.ts` and merge.
- **Add a repo:** add it to the App installations first (both environments), then to `pr_management.repos`.
- **Logs:** `npx wrangler tail --env <env>`, or Workers Logs in the Cloudflare dashboard.
- **Rotate the GitHub key:** generate a new key on the App's page, convert it, `wrangler secret put GITHUB_APP_PRIVATE_KEY`, then delete the old key on GitHub.
