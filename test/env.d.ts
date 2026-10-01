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
}
