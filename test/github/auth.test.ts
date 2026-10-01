import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assertPkcs8PrivateKey,
  type CachedToken,
  createInstallationTokens,
  readGitHubAppAuth,
  readGitHubAppCredentials,
  TOKEN_CACHE_KEY,
} from "../../src/github/auth";
import { createTokenRequest } from "../../src/github/client";
import { FakeClock } from "../fakes/clock";
import { stubGitHubApi, TOKEN_PATH } from "../helpers/github";

const secrets = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  GITHUB_INSTALLATION_ID: "67890",
  GITHUB_WEBHOOK_SECRET: "shh",
};

describe("readGitHubAppCredentials", () => {
  it("reads and checks the four secrets", () => {
    expect(readGitHubAppCredentials(secrets)).toEqual({
      appId: "12345",
      privateKey: env.GITHUB_APP_PRIVATE_KEY.trim(),
      installationId: 67890,
      webhookSecret: "shh",
    });
  });

  it.each(Object.keys(secrets))("fails without %s", (name) => {
    expect(() => readGitHubAppCredentials({ ...secrets, [name]: "" })).toThrow(`Missing secret ${name}`);
  });

  it.each(["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID"])("requires %s to be a positive integer", (name) => {
    for (const value of ["abc", "-3", "1.5"]) {
      expect(() => readGitHubAppCredentials({ ...secrets, [name]: value })).toThrow(
        `${name} must be a positive integer`,
      );
    }
  });
});

describe("readGitHubAppAuth", () => {
  it("reads the token secrets without needing the webhook secret", () => {
    const { GITHUB_WEBHOOK_SECRET: _unused, ...tokenSecrets } = secrets;
    expect(readGitHubAppAuth(tokenSecrets)).toEqual({
      appId: "12345",
      privateKey: env.GITHUB_APP_PRIVATE_KEY.trim(),
      installationId: 67890,
    });
  });
});

describe("assertPkcs8PrivateKey", () => {
  it("rejects GitHub's PKCS#1 key with the conversion command", () => {
    expect(() => assertPkcs8PrivateKey(env.TEST_GITHUB_PKCS1_KEY)).toThrow(
      "GITHUB_APP_PRIVATE_KEY is a PKCS#1 key, but Workers need PKCS#8. Convert it with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem",
    );
  });

  it.each([
    "not a key",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nabc",
  ])("rejects anything but an unencrypted PKCS#8 PEM: %s", (key) => {
    expect(() => assertPkcs8PrivateKey(key)).toThrow("not an unencrypted PKCS#8 PEM");
  });

  it("turns escaped newlines from one-line secrets back into newlines", () => {
    const oneLine = env.GITHUB_APP_PRIVATE_KEY.trim().replaceAll("\n", "\\n");
    expect(assertPkcs8PrivateKey(oneLine)).toBe(env.GITHUB_APP_PRIVATE_KEY.trim());
  });
});

function tokenSource(options: { privateKey?: string; tokenExpiresAt?: string; clock?: FakeClock } = {}) {
  const api = stubGitHubApi(undefined, { tokenExpiresAt: options.tokenExpiresAt });
  const clock = options.clock ?? new FakeClock();
  const tokens = createInstallationTokens({
    credentials: {
      appId: "12345",
      privateKey: options.privateKey ?? assertPkcs8PrivateKey(env.GITHUB_APP_PRIVATE_KEY),
      installationId: 67890,
    },
    kv: env.NATHAN_KV,
    clock,
    request: createTokenRequest(api.fetch),
  });
  return { tokens, api, clock };
}

async function verifyRs256(jwt: string, spkiPem: string): Promise<Record<string, unknown>> {
  const [header, payload, signature] = jwt.split(".") as [string, string, string];
  const der = Uint8Array.from(atob(spkiPem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const fromBase64Url = (s: string) =>
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64Url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  expect(valid).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(fromBase64Url(header)))).toMatchObject({ alg: "RS256" });
  return JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
}

describe("installation tokens", () => {
  it("signs the App JWT with the PKCS#8 key in workerd and mints a token with it", async () => {
    const { tokens, api } = tokenSource();
    expect(await tokens.get()).toBe("ghs_token1");
    const mint = api.calls.find((call) => call.path === TOKEN_PATH);
    const jwt = mint?.authorization?.replace(/^bearer /, "") ?? "";
    const claims = await verifyRs256(jwt, env.TEST_GITHUB_PUBLIC_KEY);
    expect(claims.iss).toBe("12345");
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(600);
  });

  it("is why the startup check exists: workerd's JWT signer rejects PKCS#1", async () => {
    const { tokens, api } = tokenSource({ privateKey: env.TEST_GITHUB_PKCS1_KEY });
    await expect(tokens.get()).rejects.toThrow("PKCS#1");
    expect(api.calls).toEqual([]);
  });

  it("stores a minted token in KV until five minutes before it expires", async () => {
    const { tokens } = tokenSource();
    await tokens.get();
    expect(await env.NATHAN_KV.get<CachedToken>(TOKEN_CACHE_KEY, "json")).toEqual({
      token: "ghs_token1",
      expiresAt: "2026-10-05T15:00:00Z",
    });
  });

  it("reuses the token from memory, then from KV in a new isolate", async () => {
    const first = tokenSource();
    await first.tokens.get();
    expect(await first.tokens.get()).toBe("ghs_token1");
    expect(first.api.mints()).toBe(1);

    const coldIsolate = tokenSource();
    expect(await coldIsolate.tokens.get()).toBe("ghs_token1");
    expect(coldIsolate.api.mints()).toBe(0);
  });

  it("mints a new token once the cached one is within five minutes of expiring", async () => {
    const { tokens, api, clock } = tokenSource();
    await tokens.get();
    clock.set("2026-10-05T14:54:59Z");
    expect(await tokens.get()).toBe("ghs_token1");
    clock.set("2026-10-05T14:55:00Z");
    expect(await tokens.get()).toBe("ghs_token2");
    expect(api.mints()).toBe(2);
  });

  it("ignores a KV token that is about to expire", async () => {
    await env.NATHAN_KV.put(TOKEN_CACHE_KEY, JSON.stringify({ token: "old", expiresAt: "2026-10-05T14:02:00Z" }));
    const { tokens } = tokenSource();
    expect(await tokens.get()).toBe("ghs_token1");
  });

  it("mints once for concurrent requests", async () => {
    const { tokens, api } = tokenSource();
    expect(await Promise.all([tokens.get(), tokens.get(), tokens.get()])).toEqual([
      "ghs_token1",
      "ghs_token1",
      "ghs_token1",
    ]);
    expect(api.mints()).toBe(1);
  });

  it("mints a fresh token after invalidate, bypassing every cache", async () => {
    const { tokens, api } = tokenSource();
    await tokens.get();
    await tokens.invalidate();
    expect(await env.NATHAN_KV.get(TOKEN_CACHE_KEY)).toBeNull();
    expect(await tokens.get()).toBe("ghs_token2");
    expect(api.mints()).toBe(2);
  });
});
