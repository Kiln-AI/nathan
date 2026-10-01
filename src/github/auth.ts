import { createAppAuth } from "@octokit/auth-app";
import type { Octokit } from "@octokit/core";
import { DateTime } from "luxon";
import { requireSecret } from "../core/env";
import type { Clock } from "../core/time";

export interface GitHubAppCredentials {
  appId: string;
  /** PKCS#8 PEM. */
  privateKey: string;
  installationId: number;
  webhookSecret: string;
}

export const PKCS8_CONVERSION_COMMAND = "openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem";

/** Reads and checks the GitHub App secrets. Throws at startup when one is missing or malformed. */
export function readGitHubAppCredentials(env: object): GitHubAppCredentials {
  return {
    appId: String(positiveInteger(requireSecret(env, "GITHUB_APP_ID"), "GITHUB_APP_ID")),
    privateKey: assertPkcs8PrivateKey(requireSecret(env, "GITHUB_APP_PRIVATE_KEY")),
    installationId: positiveInteger(requireSecret(env, "GITHUB_INSTALLATION_ID"), "GITHUB_INSTALLATION_ID"),
    webhookSecret: requireSecret(env, "GITHUB_WEBHOOK_SECRET"),
  };
}

/**
 * Workers' Web Crypto only imports PKCS#8 keys, but GitHub hands out PKCS#1. The JWT library's
 * Node build converts silently, so this is checked at startup rather than discovered on first use.
 * Secrets set on one line often carry literal "\n"s; they are turned back into newlines.
 */
export function assertPkcs8PrivateKey(secret: string): string {
  const pem = secret.replaceAll("\\n", "\n").trim();
  if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    throw new Error(
      `GITHUB_APP_PRIVATE_KEY is a PKCS#1 key, but Workers need PKCS#8. Convert it with: ${PKCS8_CONVERSION_COMMAND}`,
    );
  }
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----") || !pem.includes("-----END PRIVATE KEY-----")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not an unencrypted PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)");
  }
  return pem;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

// ---- Installation tokens -------------------------------------------------------------------

export const TOKEN_CACHE_KEY = "gh:installation-token";
/** A cached token is only reused while it has at least this long left. */
export const TOKEN_REFRESH_MARGIN_MINUTES = 5;
/** Cloudflare KV's minimum expirationTtl. */
const KV_MIN_TTL_SECONDS = 60;

export interface CachedToken {
  token: string;
  /** ISO 8601, as GitHub returns it. */
  expiresAt: string;
}

export interface InstallationTokens {
  get(): Promise<string>;
  /** Drops the cached token, e.g. after GitHub rejected it. */
  invalidate(): Promise<void>;
}

export interface InstallationTokenDeps {
  credentials: Pick<GitHubAppCredentials, "appId" | "privateKey" | "installationId">;
  kv: KVNamespace;
  clock: Clock;
  /** An unauthenticated Octokit `request`, used to mint tokens. */
  request: Octokit["request"];
}

/**
 * Installation tokens last an hour. They're cached per isolate and in KV, so cold isolates
 * (e.g. the one validating a modal inside Slack's 3s ack) skip the JWT signing and mint request.
 */
export function createInstallationTokens({
  credentials,
  kv,
  clock,
  request,
}: InstallationTokenDeps): InstallationTokens {
  const appAuth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    installationId: credentials.installationId,
    request,
  });
  let memory: CachedToken | undefined;
  let minting: Promise<CachedToken> | undefined;

  /** The token, if it has at least the refresh margin left. */
  const usable = (cached: CachedToken | null | undefined): string | undefined =>
    cached && DateTime.fromISO(cached.expiresAt) > clock.now().plus({ minutes: TOKEN_REFRESH_MARGIN_MINUTES })
      ? cached.token
      : undefined;

  async function mint(): Promise<CachedToken> {
    // `refresh` skips auth-app's own in-memory cache, which would return a token we just invalidated.
    const { token, expiresAt } = await appAuth({ type: "installation", refresh: true });
    const cached = { token, expiresAt };
    const reusableFor = DateTime.fromISO(expiresAt)
      .minus({ minutes: TOKEN_REFRESH_MARGIN_MINUTES })
      .diff(clock.now())
      .as("seconds");
    await kv.put(TOKEN_CACHE_KEY, JSON.stringify(cached), {
      expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.floor(reusableFor)),
    });
    return cached;
  }

  return {
    async get() {
      const inMemory = usable(memory);
      if (inMemory) return inMemory;
      const stored = await kv.get<CachedToken>(TOKEN_CACHE_KEY, "json");
      const fromKv = usable(stored);
      if (fromKv) {
        memory = stored ?? undefined;
        return fromKv;
      }
      minting ??= mint().finally(() => {
        minting = undefined;
      });
      memory = await minting;
      return memory.token;
    },
    async invalidate() {
      memory = undefined;
      await kv.delete(TOKEN_CACHE_KEY);
    },
  };
}
