import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/core/env";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}

interface TestEnv extends Env {
  TEST_MIGRATIONS: D1Migration[];
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  /** The test App key in PKCS#1, as GitHub hands it out. */
  TEST_GITHUB_PKCS1_KEY: string;
  TEST_GITHUB_PUBLIC_KEY: string;
}
