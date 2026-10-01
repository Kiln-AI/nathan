# Client Libraries and App Auth on Cloudflare Workers (TypeScript)

## 1. Package landscape (npm registry, checked 2026-10-01)

| Package | Latest | Published | Role |
|---|---|---|---|
| `@octokit/core` | 7.0.8 | 2026-08-30 | Minimal client (REST `request` + `graphql`), plugin host |
| `@octokit/auth-app` | 8.3.1 | 2026-09-01 | App JWT + installation tokens, in-memory token cache (`toad-cache`) |
| `universal-github-app-jwt` | 2.2.2 | 2025-03-17 | JWT signer used by auth-app (Web Crypto) |
| `@octokit/webhooks-methods` | 6.0.0 | 2025-05-20 | `sign` / `verify` / `verifyWithFallback` |
| `@octokit/webhooks` | 14.2.0 | 2025-12-03 | Event emitter, typed payloads, `createWebMiddleware` |
| `@octokit/app` | 16.1.4 | 2026-08-02 | Bundles auth-app + webhooks + `getInstallationOctokit`, `eachRepository` |
| `octokit` | 5.0.5 | 2025-10-31 | "Batteries included": app + REST endpoint methods + paginate (REST + GraphQL) + retry + throttling |
| `@octokit/plugin-paginate-graphql` | 6.0.0 | 2025-05-20 | `octokit.graphql.paginate` |
| `@octokit/plugin-retry` / `-throttling` | 8.1.1 / 11.0.5 | 2026-08-01 | Retry and rate-limit handling (uses `bottleneck`) |
| `@octokit/graphql-schema` | 15.26.1 | 2025-11-24 | Generated TS types for the GraphQL schema |

All `@octokit/*` packages declare `"engines": {"node": ">= 20"}` and are ESM-only (`"type": "module"`). The engines field doesn't stop Workers bundling (verified below).

Export conditions that matter on Workers (from the published `package.json`s):
- `@octokit/webhooks-methods`: `{"node": dist-node, "browser": dist-web, "default": dist-node}`.
- `@octokit/app`: `{"node": dist-node, "browser": dist-web, "default": dist-node}`.
- `universal-github-app-jwt`: internal import map `"#crypto": {"node": "./lib/crypto-node.js", "default": "./lib/crypto-native.js"}`.

**Wrangler's resolve conditions** (from `packages/wrangler/src/deployment-bundle/bundle.ts`, [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/deployment-bundle/bundle.ts)): "If we do not override these in an env var, we will set them to "workerd", "worker" and "browser"." There's no `node` condition, so Wrangler picks the Web-Crypto builds above. This is why the PKCS#1 point below bites.

## 2. Private key format: the main Workers gotcha

- GitHub docs (`managing-private-keys-for-github-apps.md`): "the PEM file you download will be in `PKCS#1 RSAPrivateKey` format." Also: "Private keys do not expire and instead need to be manually revoked."
- `universal-github-app-jwt` README: "When downloading a `private-key.pem` file from GitHub, the format is in `PKCS#1` format. Unfortunately, the WebCrypto API only supports `PKCS#8`."
- Source (`lib/get-token.js`): under the non-Node build it throws `"[universal-github-app-jwt] Private Key is in PKCS#1 format, but only PKCS#8 is supported."` The Node build (`lib/crypto-node.js`) silently converts PKCS#1 using `node:crypto.createPrivateKey`, so **code that works in Node tests can fail on Workers**.
- Conversion (README and `@octokit/auth-app` README): `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in private-key.pem -out private-key-pkcs8.key`. The first line changes from `-----BEGIN RSA PRIVATE KEY-----` to `-----BEGIN PRIVATE KEY-----`.
- The library also replaces literal `\n` with newlines ("Private keys are often times configured as environment variables, in which case line breaks are escaped"), so a single-line secret works.
- Store it with `wrangler secret put GITHUB_APP_PRIVATE_KEY` (the PKCS#8 PEM). Locally, use `.dev.vars`.

**Empirically verified (2026-10-01, wrangler 4.145.0 / local workerd, `compatibility_date: 2026-09-01`, no `nodejs_compat` flag):**
- `createAppAuth({appId, privateKey: <PKCS#8>})({type:"app"})` produced an RS256 JWT with `iat = now−30`, `exp = iat+600`, `iss = appId`.
- The same call with the PKCS#1 key threw the error above.
- `Octokit` from `@octokit/core` with `paginateGraphQL`, `retry` and `throttling` plugins, `@octokit/app`'s `App`, and the `octokit` package's `App` all instantiate fine.
- Bundle size with *all* of these: 354 KiB raw / 65 KiB gzip. With core + auth-app + webhooks-methods + plugins only: 210 KiB / 45 KiB.
- No network calls to GitHub were made. Token exchange (`POST /app/installations/{id}/access_tokens`) and real API calls were **not** exercised.

## 3. JWT and installation-token facts (GitHub docs source)

- JWT claims (verbatim table): `iat` "we recommend that you set this 60 seconds in the past"; `exp` "must be no more than 10 minutes into the future"; `iss` "The client ID or application ID ... Use of the client ID is recommended."; `alg` "should be `RS256`".
- Installation token: "The installation access token will expire after 1 hour." It can be down-scoped by `permissions` and `repositories` (see [permissions.md §5](./permissions.md)).
- `universal-github-app-jwt` sets `iat` 30s in the past and `exp = iat + 600` (source `index.js`). Clock-drift 401s ("'Expiration time' claim ('exp') is too far in the future") were reported in [auth-app.js#698](https://github.com/octokit/auth-app.js/issues/698) (2025-04, Node, marked released).
- **[Workers-specific]** Cloudflare docs: "`Date.now()` returns the time of the last I/O. It does not advance during code execution." ([Workers security model](https://developers.cloudflare.com/workers/reference/security-model/)). **[inference]** This is harmless for JWTs, because the clock is accurate as of the last I/O and the margin is 30s+.

## 4. Token caching on Workers

- `@octokit/auth-app` README: "Installation tokens expire after an hour. By default, `@octokit/auth-app` is caching up to 15000 tokens simultaneously using toad-cache. You can pass your own cache implementation by passing `options.cache.{get,set}`".
- **[inference]** Workers isolates are short-lived and not shared, so the in-memory cache helps only within one isolate. Each cold isolate signs a JWT (cheap, Web Crypto) and mints a token (one `POST`). At Nathan's volume that's fine. To be tidy, plug `cache.{get,set}` into KV with a ~55-minute TTL. That also keeps well under the "2,000 OAuth access token requests per hour" secondary limit.

## 5. Webhook handling on Workers

- `@octokit/webhooks` README: "The middleware returned from `createWebMiddleware` can also be used in serverless environments like AWS Lambda, Cloudflare Workers, and Vercel."
- Source (`src/middleware/create-middleware.ts`): the middleware **awaits handler completion** and has a `timeout = 9000` ms default. After that it responds `202 "still processing"`, because "GitHub will abort the request if it does not receive a response within 10s". **[inference]** On Workers, work left running after the Response is returned isn't guaranteed unless it's wrapped in `ctx.waitUntil()`, and the middleware doesn't do that. So prefer: `verify()` → `ctx.waitUntil(process(...))` (or enqueue) → return 202 yourself.
- Known past bug: [webhooks.js#1139](https://github.com/octokit/webhooks.js/issues/1139) (2025-04-27, v13.8.0): `TypeError: setTimeout(...).unref is not a function` in the web middleware on Cloudflare Workers. It's closed. The current source no longer has `.unref` in the web path I read, but I didn't test `createWebMiddleware` itself.
- Types without the runtime: `@octokit/webhooks` re-exports payload types (`EmitterWebhookEvent<"pull_request.review_requested">`). You can import types only and keep the runtime to `webhooks-methods`.

## 6. Recommended minimal stack

```ts
import { Octokit as Core } from "@octokit/core";
import { createAppAuth } from "@octokit/auth-app";
import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { verify } from "@octokit/webhooks-methods";
import type { EmitterWebhookEvent } from "@octokit/webhooks";

const GH = Core.plugin(paginateGraphQL, retry, throttling);

export function installationClient(env: Env, perms: Record<string, "read" | "write">) {
  return new GH({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,          // or client ID
      privateKey: env.GITHUB_APP_PRIVATE_KEY, // PKCS#8 PEM!
      installationId: Number(env.GITHUB_INSTALLATION_ID),
      // per-token down-scoping is done via auth({type:"installation", permissions})
    },
    throttle: {
      onRateLimit: (retryAfter, opts, o, retryCount) => retryCount < 1,
      onSecondaryRateLimit: () => false, // let the next sweep catch up (spec §5)
    },
  });
}

export async function handleGithubWebhook(req: Request, env: Env, ctx: ExecutionContext) {
  const body = await req.text();                          // raw bytes, before JSON.parse
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  if (!sig || !(await verify(env.GITHUB_WEBHOOK_SECRET, body, sig))) return new Response("bad sig", { status: 401 });
  const name = req.headers.get("x-github-event")!;
  const id = req.headers.get("x-github-delivery")!;
  ctx.waitUntil(routeEvent(env, name, id, JSON.parse(body)));  // or env.QUEUE.send(...)
  return new Response(null, { status: 202 });
}
```

The `throttling` plugin *requires* `onRateLimit` and `onSecondaryRateLimit`. In the test, constructing `@octokit/app`'s `App` with a throttled Octokit class threw "You must pass the onSecondaryRateLimit and onRateLimit error handlers" until the class was wrapped with `.defaults({ throttle: {...} })`.

**Alternatives considered:**
- **Hand-rolled `fetch` + Web Crypto JWT:** about 60 lines, zero deps. It's viable; the GitHub docs' own HMAC example is Web Crypto. But Octokit's maintained auth, retry and throttling are worth the ~45 KiB gzip.
- **`octokit` (all-in-one):** works on Workers (verified to instantiate) but bundles OAuth-app code Nathan doesn't need. Fine if the team prefers one import.
- **Probot:** not researched. It's built on Node HTTP servers and isn't a natural fit for Workers. Out of scope.
