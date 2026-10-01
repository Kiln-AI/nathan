import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  // A throwaway GitHub App key, generated per run so no key material is committed.
  const githubKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SLACK_SIGNING_SECRET: "test-signing-secret",
            SLACK_BOT_TOKEN: "xoxb-test-token",
            GITHUB_APP_ID: "12345",
            GITHUB_INSTALLATION_ID: "67890",
            GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
            GITHUB_APP_PRIVATE_KEY: githubKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
            TEST_GITHUB_PKCS1_KEY: githubKey.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
            TEST_GITHUB_PUBLIC_KEY: githubKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      restoreMocks: true,
      // V8 coverage doesn't work inside workerd; istanbul instruments the source instead.
      coverage: { provider: "istanbul" as const, include: ["src/**"] },
    },
  };
});
