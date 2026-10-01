import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { aPR } from "../../builders/github";
import checkRunFork from "../../fixtures/github/webhook_check_run_fork.json?raw";
import pullRequest from "../../fixtures/github/webhook_pull_request.json?raw";
import review from "../../fixtures/github/webhook_pull_request_review.json?raw";
import status from "../../fixtures/github/webhook_status.json?raw";
import { deliverQueued } from "../../helpers/app";
import { fixture, signedWebhookRequest } from "../../helpers/github";
import { PR_CHANNEL, type PRTestApp, prApp, REPO } from "../../helpers/pr";

const HEAD = "aaaa000000000000000000000000000000000001";
const FORK_HEAD = "eeee000000000000000000000000000000000005";

async function deliver(h: PRTestApp, event: string, payload: Record<string, unknown>) {
  const response = await h.app.fetch(await signedWebhookRequest(event, payload), createExecutionContext());
  expect(response.status).toBe(202);
}

/** Runs queued jobs (ignoring their delays) until the queue is empty. */
async function drain(h: PRTestApp) {
  for (let round = 0; round < 10 && h.queue.sent.length > 0; round++) await deliverQueued(h);
}

const withRepo = (payload: Record<string, unknown>, fullName: string) => ({
  ...payload,
  repository: { ...(payload.repository as object), full_name: fullName },
});

describe("pr_management webhooks", () => {
  it("records a review request and debounces a refresh of the PR by 60 seconds", async () => {
    const h = prApp();
    h.github.upsert(aPR({ headSha: "old" }));
    await h.refresh(101);

    await deliver(h, "pull_request", fixture(pullRequest));
    expect(await h.events(101)).toMatchObject([
      { event: "pull_request", action: "review_requested", actor: "alice", subject: "bob" },
    ]);
    expect((await h.record(101))?.headSha).toBe(HEAD);
    expect(h.queue.sent).toEqual([
      {
        body: { job: "core.debounced", payload: expect.objectContaining({ key: `pr_management.refresh:${REPO}#101` }) },
        delaySeconds: 60,
      },
    ]);
  });

  it("records the submitted review's state", async () => {
    const h = prApp();
    await deliver(h, "pull_request_review", fixture(review));
    expect(await h.events(101)).toMatchObject([
      { event: "pull_request_review", action: "submitted", actor: "bob", subject: "approved" },
    ]);
  });

  it("ignores untracked repos and actions that can't change the state", async () => {
    const h = prApp();
    await deliver(h, "pull_request", withRepo(fixture(pullRequest), "Someone/else"));
    await deliver(h, "pull_request", { ...fixture(pullRequest), action: "labeled" });
    await deliver(h, "pull_request", { ...fixture(pullRequest), action: undefined });
    await deliver(h, "status", { ...fixture(status), repository: undefined });
    expect(await h.events(101)).toEqual([]);
    expect(h.queue.sent).toEqual([]);
  });

  it("matches the repo case-insensitively and stores the configured spelling", async () => {
    const h = prApp();
    await deliver(h, "pull_request", withRepo(fixture(pullRequest), "kiln-ai/KILN"));
    expect(await h.events(101)).toHaveLength(1);
  });

  it("maps a commit status to the open PR whose stored head it is", async () => {
    const h = prApp();
    h.github.upsert(aPR({ headSha: HEAD }));
    h.github.upsert(aPR({ number: 102, headSha: HEAD, state: "merged" }));
    await h.refresh(101);
    await h.refresh(102);

    await deliver(h, "status", fixture(status));
    expect(await h.events(101)).toMatchObject([{ event: "status", actor: "circleci-app[bot]" }]);
    expect(await h.events(102)).toEqual([]);
    expect(h.queue.jobNames()).toEqual(["core.debounced"]);
  });

  it("asks GitHub which PR a fork's check run belongs to, then refreshes it", async () => {
    const h = prApp();
    h.github.upsert(aPR({ number: 7, author: "outsider", headSha: FORK_HEAD, pendingReviewers: ["bob"] }));

    await deliver(h, "check_run", fixture(checkRunFork));
    expect(h.queue.sent[0]?.body.payload).toMatchObject({ key: `pr_management.resolve_commit:${REPO}@${FORK_HEAD}` });

    await drain(h);
    expect(await h.record(7)).toMatchObject({ category: "oss", headSha: FORK_HEAD });
    expect(h.slack.posts).toHaveLength(1);
  });

  it("does nothing more when GitHub knows no open PR for the commit", async () => {
    const h = prApp();
    await deliver(h, "check_run", fixture(checkRunFork));
    await drain(h);
    expect(h.slack.posts).toEqual([]);
  });

  it("end to end: a burst of review requests becomes one refresh and one card", async () => {
    const h = prApp();
    h.github.upsert(aPR({ pendingReviewers: ["bob", "carol"] }));
    await deliver(h, "pull_request", fixture(pullRequest));
    await deliver(h, "pull_request", {
      ...fixture(pullRequest),
      requested_reviewer: { login: "carol", type: "User" },
    });

    await deliverQueued(h);
    expect(h.queue.jobNames()).toEqual(["pr_management.refresh"]);
    await drain(h);

    expect(h.slack.posts).toHaveLength(1);
    expect(h.slack.posts[0]).toMatchObject({ channel: PR_CHANNEL });
    expect(JSON.stringify(h.slack.posts[0]?.blocks)).toContain("⏳ <@UBOB>   ⏳ <@UCAROL>");
    expect(await h.events(101)).toEqual([]);
  });
});
