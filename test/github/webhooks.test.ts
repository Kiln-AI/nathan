import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/core/app";
import { defineFeature } from "../../src/core/feature";
import type { GitHubEventName, GitHubWebhookEvent, GitHubWebhookHandler } from "../../src/github";
import { GitHubHandlers, parseWebhookEvent } from "../../src/github/webhooks";
import { aConfig } from "../builders/config";
import { FakeGitHub } from "../fakes/github";
import { FakeSlack } from "../fakes/slack";
import checkRun from "../fixtures/github/webhook_check_run.json?raw";
import checkRunFork from "../fixtures/github/webhook_check_run_fork.json?raw";
import pullRequest from "../fixtures/github/webhook_pull_request.json?raw";
import review from "../fixtures/github/webhook_pull_request_review.json?raw";
import status from "../fixtures/github/webhook_status.json?raw";
import { testApp } from "../helpers/app";
import { fixture, githubSignature, signedWebhookRequest } from "../helpers/github";

const HEAD = "aaaa000000000000000000000000000000000001";

describe("parseWebhookEvent", () => {
  it("extracts the PR, head commit, action and sender from pull_request", () => {
    const payload = fixture(pullRequest);
    expect(parseWebhookEvent("pull_request", "d1", payload)).toEqual({
      deliveryId: "d1",
      name: "pull_request",
      action: "review_requested",
      sender: "alice",
      repo: "Kiln-AI/Kiln",
      pullRequests: [101],
      headSha: HEAD,
      payload,
    });
  });

  it("extracts the PR from pull_request_review", () => {
    expect(parseWebhookEvent("pull_request_review", "d2", fixture(review))).toMatchObject({
      action: "submitted",
      sender: "bob",
      pullRequests: [101],
      headSha: HEAD,
    });
  });

  it("keeps only this repo's PRs from a check_run, and names the bot sender like REST", () => {
    expect(parseWebhookEvent("check_run", "d3", fixture(checkRun))).toMatchObject({
      action: "completed",
      sender: "github-actions[bot]",
      pullRequests: [101],
      headSha: HEAD,
    });
  });

  it("leaves a fork PR's check_run to be resolved by its head commit", () => {
    expect(parseWebhookEvent("check_run", "d4", fixture(checkRunFork))).toMatchObject({
      pullRequests: [],
      headSha: "eeee000000000000000000000000000000000005",
    });
  });

  it("reads only the commit from a status event", () => {
    expect(parseWebhookEvent("status", "d5", fixture(status))).toMatchObject({
      action: null,
      sender: "circleci-app[bot]",
      repo: "Kiln-AI/Kiln",
      pullRequests: [],
      headSha: HEAD,
    });
  });

  it.each<GitHubEventName>(["pull_request", "pull_request_review", "check_run", "status"])(
    "comes back empty for a malformed %s payload",
    (name) => {
      expect(parseWebhookEvent(name, "d6", { sender: 42, pull_request: "nope", check_run: {}, sha: 7 })).toEqual({
        deliveryId: "d6",
        name,
        action: null,
        sender: null,
        repo: null,
        pullRequests: [],
        headSha: null,
        payload: { sender: 42, pull_request: "nope", check_run: {}, sha: 7 },
      });
    },
  );
});

describe("GitHubHandlers", () => {
  it("rejects events Nathan doesn't subscribe to", () => {
    const registry = new GitHubHandlers().forFeature("alpha");
    expect(() => registry.on("issues" as GitHubEventName, async () => {})).toThrow(
      'GitHub event "issues" isn\'t one Nathan subscribes to',
    );
  });

  it("lets several features handle the same event", () => {
    const handlers = new GitHubHandlers();
    const handler: GitHubWebhookHandler = async () => {};
    handlers.forFeature("alpha").on("status", handler);
    handlers.forFeature("beta").on("status", handler);
    expect(handlers.handlersFor("status").map((h) => h.featureId)).toEqual(["alpha", "beta"]);
    expect(handlers.handlersFor("check_run")).toEqual([]);
  });
});

function watcher(id: string, events: GitHubEventName[], onEvent: (event: GitHubWebhookEvent) => Promise<void>) {
  return defineFeature({
    id,
    configSchema: z.object({}),
    register: (r) => {
      for (const event of events) r.github.on(event, onEvent);
    },
  });
}

function webhookApp(onEvent: (event: GitHubWebhookEvent) => Promise<void> = async () => {}) {
  const received: GitHubWebhookEvent[] = [];
  const h = testApp({
    features: [
      watcher("watcher", ["pull_request", "check_run"], async (event) => {
        received.push(event);
        await onEvent(event);
      }),
    ],
    config: aConfig({ features: { watcher: { enabled: true } } }),
  });
  const deliver = async (request: Request) => {
    const ctx = createExecutionContext();
    const response = await h.app.fetch(request, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { ...h, received, deliver };
}

describe("POST /github/webhooks", () => {
  it("verifies, parses and hands the event to the feature's handler, then answers 202", async () => {
    const { deliver, received } = webhookApp();
    const response = await deliver(
      await signedWebhookRequest("pull_request", fixture(pullRequest), { deliveryId: "d-1" }),
    );
    expect(response.status).toBe(202);
    expect(received).toMatchObject([{ deliveryId: "d-1", name: "pull_request", pullRequests: [101], headSha: HEAD }]);
  });

  it.each([
    ["a wrong secret", { secret: "not-the-secret" }],
    ["no signature", { headers: { "X-Hub-Signature-256": null } }],
    ["a malformed signature", { headers: { "X-Hub-Signature-256": "sha256=zz" } }],
    ["a sha1 signature", { headers: { "X-Hub-Signature-256": "sha1=0123456789abcdef0123456789abcdef01234567" } }],
  ])("rejects %s with 401 and runs nothing", async (_label, options) => {
    const { deliver, received, log } = webhookApp();
    const response = await deliver(await signedWebhookRequest("pull_request", fixture(pullRequest), options));
    expect(response.status).toBe(401);
    expect(received).toEqual([]);
    expect(log.at("warn").map((e) => e.msg)).toEqual(["Rejected a GitHub webhook with a missing or bad signature"]);
  });

  it("rejects an empty body as unsigned", async () => {
    const { deliver } = webhookApp();
    const response = await deliver(await signedWebhookRequest("pull_request", null, { body: "" }));
    expect(response.status).toBe(401);
  });

  it.each([
    ["no delivery ID", { headers: { "X-GitHub-Delivery": null } }],
    ["no event name", { headers: { "X-GitHub-Event": null } }],
    ["a body that isn't JSON", { body: "not json" }],
    ["a JSON body that isn't an object", { body: "[1,2]" }],
  ])("answers 400 for %s", async (_label, options) => {
    const { deliver, received } = webhookApp();
    const response = await deliver(await signedWebhookRequest("pull_request", fixture(pullRequest), options));
    expect(response.status).toBe(400);
    expect(received).toEqual([]);
  });

  it("acknowledges a redelivery with 200 without running handlers again", async () => {
    const { deliver, received } = webhookApp();
    const payload = fixture(pullRequest);
    expect((await deliver(await signedWebhookRequest("pull_request", payload, { deliveryId: "same" }))).status).toBe(
      202,
    );
    expect((await deliver(await signedWebhookRequest("pull_request", payload, { deliveryId: "same" }))).status).toBe(
      200,
    );
    expect(received).toHaveLength(1);
  });

  it("records each handled delivery for the hourly prune", async () => {
    const { deliver } = webhookApp();
    await deliver(await signedWebhookRequest("pull_request", fixture(pullRequest), { deliveryId: "d-9" }));
    const row = await env.DB.prepare("SELECT id, received_at FROM webhook_deliveries").first();
    expect(row).toEqual({ id: "d-9", received_at: Date.parse("2026-10-05T14:00:00Z") });
  });

  it("answers 202 to events nobody handles (including ping) without recording them", async () => {
    const { deliver, received } = webhookApp();
    for (const event of ["ping", "status", "issues"]) {
      const response = await deliver(await signedWebhookRequest(event, { zen: "Keep it logically awesome." }));
      expect(response.status).toBe(202);
    }
    expect(received).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").first("n")).toBe(0);
  });

  it("reports a throwing handler under its feature, still runs the others, and answers 202", async () => {
    const ran: string[] = [];
    const h = testApp({
      features: [
        watcher("broken", ["check_run"], async () => {
          throw new Error("handler blew up");
        }),
        watcher("healthy", ["check_run"], async () => {
          ran.push("healthy");
        }),
      ],
      config: aConfig({ features: { broken: { enabled: true }, healthy: { enabled: true } } }),
    });
    const ctx = createExecutionContext();
    const response = await h.app.fetch(await signedWebhookRequest("check_run", fixture(checkRun)), ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(202);
    expect(ran).toEqual(["healthy"]);
    expect(h.slack.posts.map((p) => p.text)).toEqual([
      ":rotating_light: [development] `broken.github:check_run` failed: handler blew up",
    ]);
  });

  it("verifies GitHub's documented test vector", async () => {
    const secret = "It's a Secret to Everybody";
    expect(await githubSignature("Hello, World!", secret)).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
    const vectorEnv = { ...env, GITHUB_WEBHOOK_SECRET: secret };
    const app = createApp(vectorEnv, {
      config: aConfig(),
      features: [],
      slack: new FakeSlack(),
      github: new FakeGitHub(),
    });
    const request = await signedWebhookRequest("pull_request", null, { body: "Hello, World!", secret });
    // The signature passes; the body then fails as JSON.
    expect((await app.fetch(request, createExecutionContext())).status).toBe(400);
  });
});
