import { env } from "cloudflare:workers";
import { readGitHubAppCredentials } from "../../src/github/auth";
import { createGitHubGateway } from "../../src/github/gateway";
import { FakeClock } from "../fakes/clock";
import { MemoryLogger } from "../fakes/log";

const WEBHOOK_URL = "https://nathan.test/github/webhooks";

/** HMAC-SHA256 hex of `body`, as GitHub sends it in X-Hub-Signature-256. */
export async function githubSignature(body: string, secret = env.GITHUB_WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A webhook delivery to /github/webhooks, signed like GitHub does. */
export async function signedWebhookRequest(
  event: string,
  payload: unknown,
  options: { deliveryId?: string; secret?: string; body?: string; headers?: Record<string, string | null> } = {},
): Promise<Request> {
  const body = options.body ?? JSON.stringify(payload);
  const headers: Record<string, string | null> = {
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": options.deliveryId ?? crypto.randomUUID(),
    "X-Hub-Signature-256": await githubSignature(body, options.secret),
    ...options.headers,
  };
  return new Request(WEBHOOK_URL, {
    method: "POST",
    body,
    headers: Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null),
    ),
  });
}

export interface ApiCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  authorization: string | null;
}

export const TOKEN_PATH = `/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`;

/**
 * A fake api.github.com behind the gateway's fetch seam. Installation tokens are minted
 * ("ghs_token1", "ghs_token2"…) expiring at `tokenExpiresAt`; everything else is answered by
 * `respond` (a plain value becomes a 200 JSON response).
 */
export function stubGitHubApi(
  respond: (call: ApiCall) => unknown = () => ({ data: {} }),
  options: { tokenExpiresAt?: string } = {},
) {
  const calls: ApiCall[] = [];
  let minted = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: ApiCall = {
      method: init?.method ?? "GET",
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    if (call.method === "POST" && call.path === TOKEN_PATH) {
      minted += 1;
      return Response.json(
        { token: `ghs_token${minted}`, expires_at: options.tokenExpiresAt ?? "2026-10-05T15:00:00Z" },
        { status: 201 },
      );
    }
    const result = respond(call);
    return result instanceof Response ? result : Response.json(result);
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    /** Calls other than token minting. */
    apiCalls: () => calls.filter((call) => call.path !== TOKEN_PATH),
    mints: () => calls.filter((call) => call.path === TOKEN_PATH).length,
  };
}

/** The real gateway (test App credentials, test KV) over a stubbed GitHub API. */
export function stubbedGateway(respond?: (call: ApiCall) => unknown, options: { tokenExpiresAt?: string } = {}) {
  const api = stubGitHubApi(respond, options);
  const clock = new FakeClock();
  const log = new MemoryLogger();
  const gateway = createGitHubGateway({
    credentials: readGitHubAppCredentials(env),
    kv: env.NATHAN_KV,
    clock,
    log,
    fetch: api.fetch,
  });
  return { gateway, api, clock, log };
}

/** A recorded GraphQL response fixture from test/fixtures/github. */
export function fixture(raw: string): Record<string, unknown> {
  return JSON.parse(raw);
}
