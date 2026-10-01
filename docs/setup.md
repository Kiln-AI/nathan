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
- GitHub: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET` *(phase 3)*

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

## GitHub App *(phase 3)*

TODO: create the App with the documented permissions and events, convert its private key to PKCS#8, and install it on the tracked repos.

## Deploying

- **GitHub Actions secrets:** add `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts, D1, KV and Queues edit permissions) and `CLOUDFLARE_ACCOUNT_ID` to the repo's `staging` and `production` environments.
- **Production** deploys on every push to `main` (`.github/workflows/deploy.yml`): checks, migrations, then `wrangler deploy --env production`.
- **Staging** deploys on demand: run the "Deploy staging" workflow with the branch or commit to deploy.
- Check a deploy with `curl https://<worker-url>/healthz`, which returns the environment and version.

## Launch checklist *(phase 8)*

TODO: staging dry-run checklist and the production cutover.
