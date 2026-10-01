import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type ReportError, RetryAfterError } from "../../src/core/errors";
import { defineFeature, type Services } from "../../src/core/feature";
import {
  createEnqueue,
  dispatchBatch,
  drainDeadLetters,
  type JobHandler,
  type JobRef,
  JobRegistry,
  MAX_DELAY_SECONDS,
} from "../../src/core/jobs";
import { aConfig } from "../builders/config";
import { fakeBatch, fakeMessage } from "../fakes/batch";
import { MemoryLogger } from "../fakes/log";
import { RecordingQueue } from "../fakes/queue";
import { deliverQueued, testApp } from "../helpers/app";

const payloadSchema = z.object({ n: z.number() });

function dispatcher(handler: JobHandler<{ n: number }>, onGiveUp?: (p: { n: number }, e: unknown) => Promise<void>) {
  const registry = new JobRegistry();
  registry.define("f.work", payloadSchema, handler, { onGiveUp });
  const reportError = vi.fn(async () => {});
  const log = new MemoryLogger();
  const dispatch = (body: unknown, attempts = 1) => {
    const message = fakeMessage(body, attempts);
    return dispatchBatch(fakeBatch([message]), { registry, reportError, log }).then(() => message.outcome);
  };
  return { dispatch, reportError, log };
}

const failing = async () => {
  throw new Error("transient");
};

describe("JobRegistry and enqueue", () => {
  it("rejects a duplicate job name", () => {
    const registry = new JobRegistry();
    registry.define("f.a", payloadSchema, async () => {});
    expect(() => registry.define("f.a", payloadSchema, async () => {})).toThrow('Job "f.a" is already defined');
  });

  it("sends the job name and payload, with an optional clamped delay", async () => {
    const queue = new RecordingQueue();
    const enqueue = createEnqueue(queue);
    const ref: JobRef<{ n: number }> = { name: "f.a", schema: payloadSchema };
    await enqueue(ref, { n: 1 });
    await enqueue(ref, { n: 2 }, { delaySeconds: 60 });
    await enqueue(ref, { n: 3 }, { delaySeconds: 10 ** 9 });
    expect(queue.sent).toEqual([
      { body: { job: "f.a", payload: { n: 1 } }, delaySeconds: undefined },
      { body: { job: "f.a", payload: { n: 2 } }, delaySeconds: 60 },
      { body: { job: "f.a", payload: { n: 3 } }, delaySeconds: MAX_DELAY_SECONDS },
    ]);
  });

  it("refuses to enqueue an invalid payload", async () => {
    const queue = new RecordingQueue();
    const ref = { name: "f.a", schema: payloadSchema } as JobRef<unknown>;
    await expect(createEnqueue(queue)(ref, { n: "nope" })).rejects.toThrow('Invalid payload for job "f.a"');
    expect(queue.sent).toEqual([]);
  });
});

describe("dispatchBatch", () => {
  it("runs the handler with the payload and attempt, then acks", async () => {
    const handler = vi.fn(async () => {});
    const { dispatch } = dispatcher(handler);
    expect(await dispatch({ job: "f.work", payload: { n: 7 } }, 2)).toEqual({ kind: "ack" });
    expect(handler).toHaveBeenCalledWith({ n: 7 }, { attempt: 2 });
  });

  it.each([
    ["a malformed envelope", { nope: true }, "Malformed job message"],
    ["an unknown job", { job: "f.missing", payload: {} }, 'Unknown job "f.missing"'],
    ["an invalid payload", { job: "f.work", payload: { n: "x" } }, 'Invalid payload for job "f.work"'],
  ])("reports and acks %s", async (_name, body, message) => {
    const handler = vi.fn(async () => {});
    const { dispatch, reportError } = dispatcher(handler);
    expect(await dispatch(body)).toEqual({ kind: "ack" });
    expect(handler).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message }),
      expect.objectContaining({ source: "jobs.dispatch" }),
    );
  });

  it("retries a failure with exponential backoff", async () => {
    const { dispatch, reportError, log } = dispatcher(failing);
    expect(await dispatch({ job: "f.work", payload: { n: 1 } }, 1)).toEqual({ kind: "retry", delaySeconds: 60 });
    expect(await dispatch({ job: "f.work", payload: { n: 1 } }, 2)).toEqual({ kind: "retry", delaySeconds: 120 });
    expect(reportError).not.toHaveBeenCalled();
    expect(log.at("warn")).toHaveLength(2);
  });

  it("retries a RetryAfterError after the delay it asks for, clamped to the queue maximum", async () => {
    let retryAfter = 900;
    const { dispatch } = dispatcher(async () => {
      throw new RetryAfterError("rate limited", retryAfter);
    });
    expect(await dispatch({ job: "f.work", payload: { n: 1 } })).toEqual({ kind: "retry", delaySeconds: 900 });
    retryAfter = 10 ** 6;
    expect(await dispatch({ job: "f.work", payload: { n: 1 } })).toEqual({
      kind: "retry",
      delaySeconds: MAX_DELAY_SECONDS,
    });
  });

  it("gives up on the last attempt: calls onGiveUp, reports, and acks", async () => {
    const onGiveUp = vi.fn(async () => {});
    const { dispatch, reportError } = dispatcher(failing, onGiveUp);
    expect(await dispatch({ job: "f.work", payload: { n: 5 } }, 3)).toEqual({ kind: "ack" });
    expect(onGiveUp).toHaveBeenCalledWith({ n: 5 }, expect.objectContaining({ message: "transient" }));
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "transient" }), {
      source: "f.work",
      attempts: 3,
    });
  });

  it("reports an onGiveUp failure as well as the job failure", async () => {
    const { dispatch, reportError } = dispatcher(failing, async () => {
      throw new Error("DM failed");
    });
    await dispatch({ job: "f.work", payload: { n: 5 } }, 3);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "DM failed" }), {
      source: "f.work.onGiveUp",
    });
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "transient" }), expect.anything());
  });

  it("processes every message in the batch", async () => {
    const seen: number[] = [];
    const registry = new JobRegistry();
    registry.define("f.work", payloadSchema, async ({ n }) => {
      if (n === 2) throw new Error("two");
      seen.push(n);
    });
    const messages = [1, 2, 3].map((n) => fakeMessage({ job: "f.work", payload: { n } }));
    await dispatchBatch(fakeBatch(messages), { registry, reportError: async () => {}, log: new MemoryLogger() });
    expect(seen).toEqual([1, 3]);
    expect(messages.map((m) => m.outcome.kind)).toEqual(["ack", "retry", "ack"]);
  });
});

describe("drainDeadLetters", () => {
  it("reports each dead-lettered message by job name and acks it", async () => {
    const reportError = vi.fn<ReportError>(async () => {});
    const messages = [fakeMessage({ job: "f.work", payload: {} }, 4), fakeMessage("garbage", 4)];
    await drainDeadLetters(fakeBatch(messages, "nathan-jobs-dev-dlq"), reportError);
    expect(reportError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      'Job "f.work" was dead-lettered',
      'Job "unknown" was dead-lettered',
    ]);
    expect(messages.map((m) => m.outcome.kind)).toEqual(["ack", "ack"]);
  });
});

describe("debounce", () => {
  const WINDOW = { windowSeconds: 60, maxWaitSeconds: 300 };
  const refreshPayload = z.object({ pr: z.string(), n: z.number() });

  function debounceApp() {
    const runs: { pr: string; n: number }[] = [];
    let services!: Services;
    let refresh!: JobRef<{ pr: string; n: number }>;
    const feature = defineFeature({
      id: "prs",
      configSchema: z.object({}),
      register: (r) => {
        services = r.services;
        refresh = r.jobs.define("refresh", refreshPayload, async (payload) => {
          runs.push(payload);
        });
      },
    });
    const harness = testApp({ features: [feature], config: aConfig({ features: { prs: { enabled: true } } }) });
    const debounce = (n: number, key = "a/b#1") => services.debounce(refresh, key, { pr: key, n }, WINDOW);
    const debounceRow = (key = "a/b#1") =>
      env.DB.prepare("SELECT version, first_at, payload FROM debounce WHERE key = ?")
        .bind(`prs.refresh:${key}`)
        .first();
    return { ...harness, runs, debounce, debounceRow };
  }

  it("records the call and enqueues a delayed check", async () => {
    const { queue, debounce, debounceRow, clock } = debounceApp();
    await debounce(1);
    expect(queue.sent).toEqual([
      {
        body: { job: "core.debounced", payload: { key: "prs.refresh:a/b#1", version: 1, maxWaitSeconds: 300 } },
        delaySeconds: 60,
      },
    ]);
    expect(await debounceRow()).toEqual({
      version: 1,
      first_at: clock.now().toMillis(),
      payload: JSON.stringify({ pr: "a/b#1", n: 1 }),
    });
  });

  it("keeps the first call's time and the latest payload across calls", async () => {
    const { debounce, debounceRow, clock } = debounceApp();
    const firstAt = clock.now().toMillis();
    await debounce(1);
    clock.advance({ seconds: 10 });
    await debounce(2);
    expect(await debounceRow()).toEqual({
      version: 2,
      first_at: firstAt,
      payload: JSON.stringify({ pr: "a/b#1", n: 2 }),
    });
  });

  it("runs the job once, with the latest payload, after the calls go quiet", async () => {
    const h = debounceApp();
    await h.debounce(1);
    await h.debounce(2);
    await h.debounce(3);
    await deliverQueued(h); // three core.debounced checks: only the latest version fires
    expect(h.queue.jobNames()).toEqual(["prs.refresh"]);
    await deliverQueued(h);
    expect(h.runs).toEqual([{ pr: "a/b#1", n: 3 }]);
    expect(await h.debounceRow()).toBeNull();
  });

  it("keeps separate keys separate", async () => {
    const h = debounceApp();
    await h.debounce(1, "a/b#1");
    await h.debounce(2, "a/b#2");
    await deliverQueued(h);
    await deliverQueued(h);
    expect(h.runs).toEqual([
      { pr: "a/b#1", n: 1 },
      { pr: "a/b#2", n: 2 },
    ]);
  });

  it("fires on a stale check once max wait has passed, and the later check then does nothing", async () => {
    const h = debounceApp();
    await h.debounce(1);
    const [staleCheck] = h.queue.take();
    h.clock.advance({ seconds: 299 });
    await h.debounce(2);
    const [latestCheck] = h.queue.take();

    await h.app.queue(fakeBatch([fakeMessage(staleCheck?.body)]));
    expect(h.queue.sent).toEqual([]); // under max wait: the stale check defers to the latest one

    h.clock.advance({ seconds: 1 });
    await h.app.queue(fakeBatch([fakeMessage(staleCheck?.body)]));
    expect(h.queue.jobNames()).toEqual(["prs.refresh"]);
    await deliverQueued(h);
    expect(h.runs).toEqual([{ pr: "a/b#1", n: 2 }]);

    await h.app.queue(fakeBatch([fakeMessage(latestCheck?.body)]));
    expect(h.queue.sent).toEqual([]);
  });

  it("restores the row and retries when the target can't be enqueued", async () => {
    const h = debounceApp();
    await h.debounce(1);
    const [check] = h.queue.take();
    h.queue.fail();
    const failedAttempt = fakeMessage(check?.body, 1);
    await h.app.queue(fakeBatch([failedAttempt]));
    expect(failedAttempt.outcome).toEqual({ kind: "retry", delaySeconds: 60 });
    expect(await h.debounceRow()).toMatchObject({ version: 1 });

    h.queue.succeed();
    await h.app.queue(fakeBatch([fakeMessage(check?.body, 2)]));
    await deliverQueued(h);
    expect(h.runs).toEqual([{ pr: "a/b#1", n: 1 }]);
  });

  it("refuses an invalid payload", async () => {
    const h = debounceApp();
    await expect(h.debounce(Number.NaN)).rejects.toThrow('Invalid payload for job "prs.refresh"');
    expect(await h.debounceRow()).toBeNull();
  });
});

describe("debounced job lookup", () => {
  it("reports and keeps the row when the debounced job no longer exists", async () => {
    const h = testApp();
    await env.DB.prepare(
      "INSERT INTO debounce (key, job, version, first_at, payload) VALUES ('gone:k', 'gone', 1, 0, '{}')",
    ).run();
    const message = fakeMessage(
      { job: "core.debounced", payload: { key: "gone:k", version: 1, maxWaitSeconds: 300 } },
      3,
    );
    await h.app.queue(fakeBatch([message]));
    expect(message.outcome).toEqual({ kind: "ack" });
    expect(h.slack.posts[0]?.text).toContain('Debounced job "gone" is not defined');
  });

  it("does nothing for a check whose row is already gone", async () => {
    const h = testApp();
    const message = fakeMessage({ job: "core.debounced", payload: { key: "x:k", version: 1, maxWaitSeconds: 300 } });
    await h.app.queue(fakeBatch([message]));
    expect(message.outcome).toEqual({ kind: "ack" });
    expect(h.queue.sent).toEqual([]);
  });
});
