import { createExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Router } from "../../src/core/http";

describe("Router", () => {
  const ctx = createExecutionContext();
  const router = new Router();
  router.on("GET", "/thing", () => new Response("got"));
  router.on("POST", "/thing", () => new Response("posted"));

  it("dispatches by path and method", async () => {
    expect(await (await router.handle(new Request("https://n.test/thing"), ctx)).text()).toBe("got");
    expect(await (await router.handle(new Request("https://n.test/thing", { method: "POST" }), ctx)).text()).toBe(
      "posted",
    );
  });

  it("returns 404 for unknown paths and 405 for other methods", async () => {
    expect((await router.handle(new Request("https://n.test/nope"), ctx)).status).toBe(404);
    const wrongMethod = await router.handle(new Request("https://n.test/thing", { method: "PUT" }), ctx);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("GET, POST");
  });

  it("rejects a duplicate route", () => {
    expect(() => router.on("GET", "/thing", () => new Response())).toThrow("Route GET /thing is already defined");
  });
});

describe("worker fetch", () => {
  it("serves /healthz with the environment and version", async () => {
    const response = await exports.default.fetch("https://nathan.test/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ env: "development", version: expect.any(String) });
  });

  it("returns 404 for unknown paths", async () => {
    expect((await exports.default.fetch("https://nathan.test/wp-admin")).status).toBe(404);
  });
});
