import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDb } from "../../src/core/db";
import { createErrorReporter, errorMessage, MAX_ALERT_DETAILS_CHARS, runIsolated } from "../../src/core/errors";
import { FakeClock } from "../fakes/clock";
import { MemoryLogger } from "../fakes/log";
import { FakeSlack } from "../fakes/slack";

function setup() {
  const clock = new FakeClock();
  const slack = new FakeSlack();
  const log = new MemoryLogger();
  const reportError = createErrorReporter({
    log,
    db: createDb(env.DB),
    clock,
    slack,
    adminChannel: "CADMIN",
    envName: "staging",
  });
  return { clock, slack, log, reportError };
}

describe("reportError", () => {
  it("logs the error and posts it to the admin channel with its context", async () => {
    const { slack, log, reportError } = setup();
    const error = new Error("GitHub said no");
    await reportError(error, { source: "pr_management.sweep", pr: "a/b#1" });

    expect(log.at("error")).toEqual([
      { level: "error", msg: "GitHub said no", fields: { source: "pr_management.sweep", pr: "a/b#1", error } },
    ]);
    expect(slack.posts).toEqual([
      {
        channel: "CADMIN",
        text: ':rotating_light: [staging] `pr_management.sweep` failed: GitHub said no\n```{"pr":"a/b#1"}```',
      },
    ]);
  });

  it("omits the details block when the context has only a source", async () => {
    const { slack, reportError } = setup();
    await reportError("plain string", { source: "x" });
    expect(slack.posts[0]?.text).toBe(":rotating_light: [staging] `x` failed: plain string");
  });

  it("posts the same error at most once per hour, but always logs it", async () => {
    const { clock, slack, log, reportError } = setup();
    await reportError(new Error("boom"), { source: "a" });
    clock.advance({ minutes: 59 });
    await reportError(new Error("boom"), { source: "a", other: "context" });
    expect(slack.posts).toHaveLength(1);
    expect(log.at("error")).toHaveLength(2);

    clock.advance({ minutes: 1 });
    await reportError(new Error("boom"), { source: "a" });
    expect(slack.posts).toHaveLength(2);
  });

  it("dedupes by source and message", async () => {
    const { slack, reportError } = setup();
    await reportError(new Error("boom"), { source: "a" });
    await reportError(new Error("boom"), { source: "b" });
    await reportError(new Error("bang"), { source: "a" });
    expect(slack.posts).toHaveLength(3);
  });

  it("only logs when posting to Slack fails, and lets the next occurrence post", async () => {
    const { slack, log, reportError } = setup();
    slack.fail(new Error("slack down"));
    await expect(reportError(new Error("boom"), { source: "a" })).resolves.toBeUndefined();
    expect(log.at("error").map((e) => e.msg)).toEqual(["boom", "Failed to post admin alert"]);

    slack.succeed();
    await reportError(new Error("boom"), { source: "a" });
    expect(slack.posts).toHaveLength(1);
  });

  it("truncates a large details block", async () => {
    const { slack, reportError } = setup();
    await reportError(new Error("big"), { source: "a", issues: "x".repeat(10_000) });
    const text = slack.posts[0]?.text ?? "";
    expect(text.length).toBeLessThan(MAX_ALERT_DETAILS_CHARS + 200);
    expect(text).toContain("… (truncated)```");
  });

  it("still alerts when the error context can't be serialized", async () => {
    const { slack, reportError } = setup();
    await expect(reportError(new Error("odd"), { source: "a", n: 1n })).resolves.toBeUndefined();
    expect(slack.posts[0]?.text).toContain("(details not serializable)");
  });
});

describe("runIsolated", () => {
  it("reports a thrown error under the source instead of propagating it", async () => {
    const { slack, reportError } = setup();
    await expect(
      runIsolated(
        "feature.task",
        async () => {
          throw new Error("oops");
        },
        reportError,
      ),
    ).resolves.toBeUndefined();
    expect(slack.posts[0]?.text).toContain("`feature.task` failed: oops");
  });

  it("does nothing extra when the function succeeds", async () => {
    const { slack, reportError } = setup();
    let ran = false;
    await runIsolated(
      "ok",
      async () => {
        ran = true;
      },
      reportError,
    );
    expect(ran).toBe(true);
    expect(slack.posts).toEqual([]);
  });
});

describe("errorMessage", () => {
  it("uses Error messages and stringifies anything else", () => {
    expect(errorMessage(new Error("m"))).toBe("m");
    expect(errorMessage(42)).toBe("42");
  });
});
