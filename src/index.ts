import { getApp } from "./core/app";
import type { Env } from "./core/env";
import { createConsoleLogger } from "./core/log";

export default {
  async fetch(request, env, ctx) {
    let app: ReturnType<typeof getApp>;
    try {
      app = getApp(env);
    } catch (error) {
      createConsoleLogger({ env: env.NATHAN_ENV }).error("Nathan failed to start", { error });
      return new Response("Nathan failed to start; see the Worker logs", { status: 500 });
    }
    return app.fetch(request, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(getApp(env).scheduled(controller.scheduledTime));
  },

  async queue(batch, env) {
    await getApp(env).queue(batch);
  },
} satisfies ExportedHandler<Env, unknown>;
