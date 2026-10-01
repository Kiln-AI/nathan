import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp, getApp } from "../../src/core/app";
import { defineFeature, type Feature } from "../../src/core/feature";
import worker from "../../src/index";
import { aConfig } from "../builders/config";
import { fakeBatch, fakeMessage } from "../fakes/batch";
import { testApp } from "../helpers/app";

function recordingFeature(id: string, onTask: () => Promise<void> = async () => {}) {
  const calls = { register: 0, job: [] as unknown[] };
  const feature = defineFeature({
    id,
    configSchema: z.object({ label: z.string() }),
    register: (r) => {
      calls.register += 1;
      r.jobs.define("work", z.object({ n: z.number() }), async (payload) => {
        calls.job.push({ payload, label: r.config.label });
      });
      r.schedule({ name: "hourly", when: { everyHour: true }, run: onTask });
    },
  });
  return { feature, calls };
}

const enabled = (...ids: string[]) =>
  aConfig({ features: Object.fromEntries(ids.map((id) => [id, { enabled: true, label: `${id}-label` }])) });

describe("createApp", () => {
  it("registers an enabled feature's jobs under its id, with its config", async () => {
    const { feature, calls } = recordingFeature("alpha");
    const h = testApp({ features: [feature], config: enabled("alpha") });
    const message = fakeMessage({ job: "alpha.work", payload: { n: 1 } });
    await h.app.queue(fakeBatch([message]));
    expect(message.outcome).toEqual({ kind: "ack" });
    expect(calls).toEqual({ register: 1, job: [{ payload: { n: 1 }, label: "alpha-label" }] });
  });

  it("never registers a disabled feature", () => {
    const { feature, calls } = recordingFeature("alpha");
    testApp({ features: [feature], config: aConfig({ features: { alpha: { enabled: false } } }) });
    expect(calls.register).toBe(0);
  });

  it("isolates a failing scheduled task from other features", async () => {
    const ran: string[] = [];
    const broken = recordingFeature("broken", async () => {
      throw new Error("broken feature");
    });
    const healthy = recordingFeature("healthy", async () => {
      ran.push("healthy");
    });
    const h = testApp({ features: [broken.feature, healthy.feature], config: enabled("broken", "healthy") });
    await h.app.scheduled(Date.parse("2026-10-05T14:00:00Z"));
    expect(ran).toEqual(["healthy"]);
    expect(h.slack.posts.map((p) => p.text)).toEqual([
      ":rotating_light: [development] `broken.hourly` failed: broken feature",
    ]);
  });

  it("gives features a logger tagged with their id", () => {
    let logged = false;
    const feature = defineFeature({
      id: "alpha",
      configSchema: z.object({}),
      register: (r) => {
        r.services.log.info("hi");
        logged = true;
      },
    });
    const h = testApp({ features: [feature], config: aConfig({ features: { alpha: { enabled: true } } }) });
    expect(logged).toBe(true);
    expect(h.log.entries).toEqual([{ level: "info", msg: "hi", fields: { feature: "alpha" } }]);
  });

  it.each([
    ["the reserved core id", "core", "reserved or already registered"],
    ["a non-snake_case id", "PrManagement", "must be snake_case"],
  ])("rejects %s", (_name, id, message) => {
    const feature: Feature<unknown> = { id, configSchema: z.unknown(), register: () => {} };
    expect(() => testApp({ features: [feature] })).toThrow(message);
  });

  it("rejects duplicate feature ids", () => {
    const { feature } = recordingFeature("alpha");
    expect(() => testApp({ features: [feature, feature] })).toThrow(
      'Feature id "alpha" is reserved or already registered',
    );
  });

  it("prunes week-old webhook deliveries and day-old debounce rows every hour", async () => {
    const h = testApp();
    const now = Date.parse("2026-10-05T14:00:00Z");
    const hour = 60 * 60 * 1000;
    const insertDebounce = "INSERT INTO debounce (key, job, version, first_at, payload) VALUES (?, 'j', 1, ?, '{}')";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO webhook_deliveries (id, received_at) VALUES ('old', ?)").bind(
        now - 7 * 24 * hour - 1,
      ),
      env.DB.prepare("INSERT INTO webhook_deliveries (id, received_at) VALUES ('recent', ?)").bind(now - 6 * 24 * hour),
      env.DB.prepare(insertDebounce).bind("orphaned", now - 24 * hour - 1),
      env.DB.prepare(insertDebounce).bind("live", now - hour),
    ]);
    await h.app.scheduled(now);
    expect((await env.DB.prepare("SELECT id FROM webhook_deliveries").all()).results).toEqual([{ id: "recent" }]);
    expect((await env.DB.prepare("SELECT key FROM debounce").all()).results).toEqual([{ key: "live" }]);
  });

  it("returns 500 and reports when a route throws", async () => {
    const h = testApp();
    const ctx = createExecutionContext();
    const request = new Request("https://n.test/healthz");
    vi.spyOn(Response, "json").mockImplementationOnce(() => {
      throw new Error("route blew up");
    });
    const response = await h.app.fetch(request, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(500);
    expect(h.slack.posts[0]?.text).toContain("`http` failed: route blew up");
  });

  it("drains dead-letter queues instead of dispatching them", async () => {
    const h = testApp();
    const message = fakeMessage({ job: "alpha.work", payload: {} }, 4);
    await h.app.queue(fakeBatch([message], "nathan-jobs-production-dlq"));
    expect(message.outcome).toEqual({ kind: "ack" });
    expect(h.slack.posts[0]?.text).toContain('Job "alpha.work" was dead-lettered');
  });

  it("fails fast on invalid config", () => {
    expect(() => testApp({ config: aConfig({ admin: { slackChannel: "#admin" } }) })).toThrow(
      "admin.slackChannel: must be a Slack channel ID",
    );
  });

  it("loads the repo's nathan.config.ts by default", () => {
    expect(createApp(env).config.env).toBe("development");
  });

  it.each(["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"])("fails to start without the %s secret", (name) => {
    expect(() => createApp({ ...env, [name]: "" }, { config: aConfig(), features: [] })).toThrow(
      `Missing secret ${name}`,
    );
  });

  it("gives features the Slack registry and the user directory", async () => {
    let seen: { github: string | undefined; registry: boolean } | undefined;
    const feature = defineFeature({
      id: "alpha",
      configSchema: z.object({}),
      register: (r) => {
        seen = {
          github: r.services.directory.bySlack("UALICE")?.github,
          registry: typeof r.slack.shortcut === "function",
        };
      },
    });
    testApp({ features: [feature], config: aConfig({ features: { alpha: { enabled: true } } }) });
    expect(seen).toEqual({ github: "alice", registry: true });
  });

  it("reroutes feature posts and admin alerts to the test channel in dry run", async () => {
    const h = testApp({ config: aConfig({ dryRun: true, testChannel: "CTEST" }) });
    await h.app.services.slack.postMessage({ channel: "CPRS", text: "<@UALICE> please review" });
    await h.app.services.reportError(new Error("boom"), { source: "test" });
    expect(h.slack.posts.map((p) => [p.channel, p.text])).toEqual([
      ["CTEST", "[dry-run → <#CPRS>] @alice please review"],
      ["CTEST", "[dry-run → <#CADMIN>] :rotating_light: [development] `test` failed: boom"],
    ]);
  });
});

describe("getApp", () => {
  it("builds one app per env object", () => {
    expect(getApp(env)).toBe(getApp(env));
    expect(getApp({ ...env })).not.toBe(getApp(env));
  });

  it("throws on every call when the environment isn't configured", () => {
    const badEnv = { ...env, NATHAN_ENV: "nowhere" };
    expect(() => getApp(badEnv)).toThrow('no "nowhere" entry');
    expect(() => getApp(badEnv)).toThrow('no "nowhere" entry');
  });
});

describe("worker entry", () => {
  it("returns 500 when the app can't start", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await worker.fetch(
      new Request("https://n.test/healthz"),
      { ...env, NATHAN_ENV: "nowhere" },
      createExecutionContext(),
    );
    expect(response.status).toBe(500);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ level: "error", msg: "Nathan failed to start" });
  });

  it("runs a scheduler tick from the cron trigger", async () => {
    const ctx = createExecutionContext();
    const scheduledTime = Date.parse("2026-10-05T14:00:00Z");
    await worker.scheduled({ scheduledTime, cron: "*/15 * * * *", noRetry: () => {} }, env, ctx);
    await waitOnExecutionContext(ctx);
    const row = await env.DB.prepare("SELECT last_run_at FROM job_runs WHERE name = 'core.prune'").first();
    expect(row).toEqual({ last_run_at: scheduledTime });
  });

  it("consumes queue batches", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const batch = createMessageBatch("nathan-jobs-dev", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { job: "nobody.home", payload: {} } },
    ]);
    await worker.queue(batch, env);
    expect(await getQueueResult(batch, createExecutionContext())).toMatchObject({
      explicitAcks: ["m1"],
      retryMessages: [],
    });
  });
});
