# Setting up Nathan

One-time setup for Nathan's two environments, `staging` and `production`. Each environment has its own Cloudflare resources, Slack app and GitHub App. Sections marked *(phase N)* are filled in as those parts are built.

## Prerequisites

- Node 22+ and npm. Run `npm ci` once.
- A Cloudflare account on the Workers Paid plan. Log in with `npx wrangler login`.
- Admin access to the Slack workspace and owner access to the GitHub org.

## Local development

- `npm run check` runs everything CI runs: lint and format check, type-check, config validation and tests.
- `npm test` runs the tests inside workerd (Miniflare), with a real local D1, KV and queues.
- `npm run format` fixes formatting and import order.
- Live behavior is tested on staging (see [Deploying](#deploying)), which runs in dry-run mode.

## Cloudflare resources

Create these once per environment (`<env>` is `staging` or `production`), then paste the printed IDs into the matching `env.<env>` section of `wrangler.jsonc` (replacing the `REPLACE_WITH_*` placeholders).

```sh
npx wrangler d1 create nathan-<env>                # → database_id
npx wrangler kv namespace create nathan-<env>      # → KV id
npx wrangler queues create nathan-jobs-<env>
npx wrangler queues create nathan-jobs-<env>-dlq
```

Apply the database migrations (CI also does this on every deploy):

```sh
npx wrangler d1 migrations apply DB --remote --env <env>
```

## Team config

Behavior config lives in `nathan.config.ts` (users, channels, features), reviewed by PR and validated by `npm run check:config`. Slack channels and users are referenced by ID. Replace the placeholder channel IDs before the first deploy.

## Secrets

Secrets are set per environment with `npx wrangler secret put <NAME> --env <env>` and never committed. Locally, put them in `.dev.vars` (git-ignored).

- Slack: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` (see [Slack app](#slack-app)). Nathan refuses to start without them.
- GitHub: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET` (see [GitHub App](#github-app)). Nathan refuses to start without them, or with a PKCS#1 private key.

## Slack app

Each environment has its own Slack app, because a Slack app has one request URL. The manifests in the repo define everything (scopes, the Home tab, the "Request PR review" shortcut, the slash command and the event subscription):

- production: `slack-manifest.production.yaml` (`/nathan`)
- staging: `slack-manifest.staging.yaml` (`/nathan-staging`)

For each environment:

1. In the manifest, replace `REPLACE_WITH_WORKERS_SUBDOMAIN` with your `workers.dev` subdomain (shown in the Cloudflare dashboard under Workers & Pages), or point the three URLs at a custom domain. All three end in `/slack/events`.
2. At <https://api.slack.com/apps>, choose **Create New App → From a manifest**, pick the workspace and paste the manifest. Slack may warn that the event URL isn't verified yet; that is fixed in step 4.
3. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`) and, from **Basic Information**, the **Signing Secret**, set them, and deploy the Worker (see [Deploying](#deploying)):
   ```sh
   npx wrangler secret put SLACK_BOT_TOKEN --env <env>
   npx wrangler secret put SLACK_SIGNING_SECRET --env <env>
   ```
4. In the app's **Event Subscriptions** page, click **Retry** next to the request URL until it shows *Verified* (Nathan answers Slack's challenge once it has the signing secret).
5. Invite the bot to the channels it posts in: `/invite @nathan` in the PR channel and the admin channel (production), and `/invite @nathan-staging` in the test channel (staging). Nathan doesn't use `chat:write.public`, so it can only post where it's a member.
6. Check it works: open Nathan's **Home** tab, and run `/nathan help` (`/nathan-staging help`).

Notes:

- Staging runs in dry run (`nathan.config.ts`): every message goes to the test channel, labelled with where it would have gone, and mentions are rewritten so nobody is pinged. Modals, the Home tab and `/nathan` replies still reach the person using them.
- Changing scopes or events later: edit the manifest in the repo first, paste it into the app's **App Manifest** page, then reinstall the app if Slack asks.
- Local development (`npm run dev`) reads secrets from `.dev.vars` (git-ignored):
  ```
  SLACK_BOT_TOKEN=xoxb-…
  SLACK_SIGNING_SECRET=…
  ```

## GitHub App

Each environment has its own GitHub App, because an App has one webhook URL. Staging's App is installed on the same repos as production's; staging runs in dry run, so it only reads.

For each environment:

1. Generate a webhook secret, e.g. `openssl rand -hex 32`, and keep it for step 2 and step 5.
2. In the org's **Settings → Developer settings → GitHub Apps → New GitHub App**:
   - **Name:** "Nathan" (production) or "Nathan (staging)".
   - **Homepage URL:** the repo URL.
   - **Webhook:** active, URL `https://nathan-<env>.<subdomain>.workers.dev/github/webhooks`, and the secret from step 1.
   - **Repository permissions** (nothing else):

     | Permission | Access | Used for |
     |---|---|---|
     | Metadata | Read | Required by every App |
     | Pull requests | Read & write | Reading PRs, reviews and review requests; **write is only used to request reviewers** |
     | Checks | Read | CI check runs |
     | Commit statuses | Read | CI from external services (commit statuses) |

   - **Subscribe to events:** Pull request, Pull request review, Check run, Status.
   - **Where can this GitHub App be installed?** Only on this account.
3. After creating it, note the **App ID** on the App's page. Under **Private keys**, click **Generate a private key**; a `.pem` file downloads.
4. Convert the key to PKCS#8. GitHub hands out PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`), but Workers' Web Crypto only reads PKCS#8 (`-----BEGIN PRIVATE KEY-----`):
   ```sh
   openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem
   ```
5. **Install App** on the org, choosing **Only select repositories** and every repo in `pr_management.repos`. The installation ID is the number at the end of the installation's settings URL (`…/settings/installations/<id>`).
6. Set the secrets and deploy:
   ```sh
   npx wrangler secret put GITHUB_APP_ID --env <env>            # the App ID
   npx wrangler secret put GITHUB_INSTALLATION_ID --env <env>   # from step 5
   npx wrangler secret put GITHUB_WEBHOOK_SECRET --env <env>    # from step 1
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env <env> < key.pk8.pem
   ```
   Then delete both `.pem` files from your machine. A lost key is replaced by generating a new one on the App's page.
7. Check it works: on the App's **Advanced** tab, the first delivery (`ping`) should show a `202` response. Redeliver it if it was sent before the Worker had its secrets.

Notes:

- Adding a repo to `pr_management.repos` also needs the repo added to both Apps' installations (**Configure → Repository access**). The hourly sweep logs a warning for configured repos the App can't see.
- Local development (`npm run dev`) reads the same four secrets from `.dev.vars`. The private key can be on one line with `\n` for newlines.

## Deploying

- **GitHub Actions secrets:** add `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts, D1, KV and Queues edit permissions) and `CLOUDFLARE_ACCOUNT_ID` to the repo's `staging` and `production` environments.
- **Production** deploys on every push to `main` (`.github/workflows/deploy.yml`): checks, migrations, then `wrangler deploy --env production`.
- **Staging** deploys on demand: run the "Deploy staging" workflow with the branch or commit to deploy.
- Check a deploy with `curl https://<worker-url>/healthz`, which returns the environment and version.

## Launch checklist *(phase 8)*

TODO: staging dry-run checklist and the production cutover.

Cutover notes so far:

- **The first sweep backfills cards.** Within an hour of enabling `pr_management`, Nathan posts a card for every open, non-draft PR that has reviewers requested, including PRs already posted by the old Workflow Builder "Request PR" flow. Expect that burst in the PR channel (or enable the feature in a quiet moment), and retire the old workflow at the same time so new requests aren't posted twice.
