import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
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
