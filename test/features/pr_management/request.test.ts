import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { REFRESH_HOME_ACTION } from "../../../src/features/pr_management/request";
import {
  FIELD,
  MESSAGES,
  OPEN_REQUEST_PR_ACTION,
  REQUEST_PR_SHORTCUT,
  REQUEST_PR_VIEW,
  type ReviewRequest,
  requestModal,
} from "../../../src/features/pr_management/request_form";
import { GitHubApiError } from "../../../src/github";
import { aPR, aReview } from "../../builders/github";
import { deliverQueued } from "../../helpers/app";
import { PR_CHANNEL, type PRTestApp, prApp, prConfig, REPO } from "../../helpers/pr";
import {
  appHomeOpenedBody,
  blockActionBody,
  shortcutBody,
  signedSlackRequest,
  viewSubmissionBody,
} from "../../helpers/slack";

const URL = `https://github.com/${REPO}/pull/101`;

interface Form {
  url?: string;
  reviewers?: string[];
  modifiers?: string[];
  note?: string;
}

function formValues({ url = URL, reviewers = ["UBOB"], modifiers = [], note }: Form = {}) {
  return {
    [FIELD.url]: { [FIELD.url]: { type: "url_text_input", value: url } },
    [FIELD.modifiers]: {
      [FIELD.modifiers]: {
        type: "checkboxes",
        selected_options: modifiers.map((value) => ({ text: { type: "plain_text", text: value }, value })),
      },
    },
    [FIELD.reviewers]: { [FIELD.reviewers]: { type: "multi_users_select", selected_users: reviewers } },
    [FIELD.note]: { [FIELD.note]: { type: "plain_text_input", value: note ?? null } },
  };
}

async function send(h: PRTestApp, body: string, contentType?: string) {
  const ctx = createExecutionContext();
  const response = await h.app.fetch(await signedSlackRequest(body, { contentType }), ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, text };
}

function submit(h: PRTestApp, form: Form = {}, userId = "UALICE") {
  return send(h, viewSubmissionBody(REQUEST_PR_VIEW, formValues(form), { userId }));
}

/** Runs queued jobs (ignoring their delays) until the queue is empty. */
async function drain(h: PRTestApp) {
  for (let round = 0; round < 10 && h.queue.sent.length > 0; round++) await deliverQueued(h);
}

const request = (overrides: Partial<ReviewRequest> = {}): ReviewRequest => ({
  repo: REPO,
  number: 101,
  reviewers: ["bob"],
  modifiers: [],
  note: null,
  submittedBy: "UALICE",
  ...overrides,
});

const threadReplies = (h: PRTestApp) => h.slack.posts.filter((post) => post.thread_ts !== undefined);
const topLevel = (h: PRTestApp) => h.slack.posts.filter((post) => post.thread_ts === undefined);

describe("Request PR: opening the form", () => {
  it("opens the modal from the global shortcut", async () => {
    const h = prApp();
    const result = await send(h, shortcutBody(REQUEST_PR_SHORTCUT));
    expect(result).toEqual({ status: 200, text: "" });
    expect(h.slack.openedViews).toEqual([{ triggerId: "trigger-1", view: requestModal() }]);
  });

  it("shows a Request PR button in the App Home that opens the modal", async () => {
    const h = prApp();
    await send(h, appHomeOpenedBody("UALICE"), "application/json");
    const home = JSON.stringify(h.slack.homes[0]?.view.blocks);
    expect(home).toContain(`"action_id":"${OPEN_REQUEST_PR_ACTION}"`);
    // Beside it: a secondary Refresh button labelled with when the view was rendered, in the
    // viewer's zone (14:00 UTC is 10:00 in Toronto).
    expect(home).toContain(`"action_id":"${REFRESH_HOME_ACTION}"`);
    expect(home).toContain('"text":"↻ Refresh · 10:00 AM"');

    await send(h, blockActionBody({ action_id: OPEN_REQUEST_PR_ACTION }));
    expect(h.slack.openedViews).toEqual([{ triggerId: "trigger-3", view: requestModal() }]);
  });
});

describe("Request PR: submitting", () => {
  it("shows validation errors inline and queues nothing", async () => {
    const h = prApp();
    h.github.upsert(aPR({ isDraft: true }));
    const result = await submit(h);
    expect(JSON.parse(result.text)).toEqual({ response_action: "errors", errors: { [FIELD.url]: MESSAGES.draft } });
    expect(h.queue.sent).toEqual([]);
  });

  it("names an unmapped reviewer by their Slack name", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    h.slack.names.set("UJANE", "Jane Doe");
    const result = await submit(h, { reviewers: ["UJANE"] });
    expect(JSON.parse(result.text)).toEqual({
      response_action: "errors",
      errors: { [FIELD.reviewers]: MESSAGES.unmapped(["Jane Doe"]) },
    });
  });

  it("closes the modal and queues the request", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    const result = await submit(h, {
      reviewers: ["UBOB", "UCAROL"],
      modifiers: ["urgent"],
      note: "Blocks the release",
    });
    expect(result).toEqual({ status: 200, text: "" });
    expect(h.queue.sent).toEqual([
      {
        body: {
          job: "pr_management.request_review",
          payload: request({ reviewers: ["bob", "carol"], modifiers: ["urgent"], note: "Blocks the release" }),
        },
        delaySeconds: undefined,
      },
    ]);
  });

  it("keeps the modal open with an error when the request can't be queued", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    h.queue.fail();
    const result = await submit(h);
    expect(JSON.parse(result.text)).toEqual({
      response_action: "errors",
      errors: { [FIELD.url]: MESSAGES.queueFailed },
    });
  });
});

describe("Request PR: a first request", () => {
  it("requests the reviewers on GitHub, then posts the card with the form's details", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    await submit(h, { reviewers: ["UCAROL"], modifiers: ["quick", "urgent"], note: "Small fix" }, "UBOB");
    await drain(h);

    expect(h.github.reviewerRequests).toEqual([{ repo: REPO, number: 101, logins: ["carol"] }]);
    expect(h.github.labelRequests).toEqual([{ repo: REPO, number: 101, labels: ["quick", "urgent"] }]);
    expect(h.slack.posts).toHaveLength(1);
    const [card] = h.slack.posts;
    expect(card?.channel).toBe(PR_CHANNEL);
    const blocks = JSON.stringify(card?.blocks);
    expect(blocks).toContain("`quick`");
    expect(blocks).toContain("`urgent`");
    expect(blocks).toContain("> Small fix");
    expect(blocks).toContain("⏳ <@UCAROL>");
    expect(blocks).toContain("Requested by <@UBOB>");
    expect(await h.record(101)).toMatchObject({
      state: "awaiting_review",
      owners: ["carol"],
      modifiers: ["quick", "urgent"],
      note: "Small fix",
      submittedBy: "UBOB",
      card: { channel: PR_CHANNEL },
    });
  });

  it("shows the PR's existing modifier labels on the card, whatever their case", async () => {
    const h = prApp();
    h.github.upsert(aPR({ labels: ["Large", "bug"] }));
    await submit(h);
    await drain(h);
    expect(h.github.labelRequests).toEqual([]);
    expect(await h.record(101)).toMatchObject({ modifiers: ["large"] });
    expect(JSON.stringify(h.slack.posts[0]?.blocks)).toContain("`large`");
  });

  it("in dry run, writes nothing to GitHub but still posts the card to the test channel", async () => {
    const config = prConfig();
    config.environments = { development: { dryRun: true, testChannel: "CTEST" } };
    const h = prApp({ config });
    h.github.upsert(aPR());
    await submit(h, { modifiers: ["urgent"] });
    await drain(h);
    expect(h.github.reviewerRequests).toEqual([]);
    expect(h.github.labelRequests).toEqual([]);
    expect(h.slack.posts.map((post) => post.channel)).toEqual(["CTEST"]);
  });
});

describe("Request PR: a re-request", () => {
  /** alice's PR with a card, after bob requested changes. Clears the recorded Slack calls. */
  async function reviewedByBob(h: PRTestApp) {
    h.github.upsert(aPR());
    await submit(h, { note: "First pass" });
    await drain(h);
    h.github.upsert(aPR({ reviews: [aReview({ author: "bob", state: "changes_requested" })] }));
    h.clock.advance({ hours: 2 });
    await h.refresh(101);
    h.slack.posts.length = 0;
    h.slack.updates.length = 0;
  }

  it("updates the card in place and replies in its thread, without tagging the submitter", async () => {
    const h = prApp();
    await reviewedByBob(h);
    const card = (await h.record(101))?.card;

    await submit(h, { reviewers: ["UBOB", "UALICE"], modifiers: ["urgent"], note: "Addressed it" });
    await drain(h);

    expect(topLevel(h)).toEqual([]);
    expect(h.slack.updates).toHaveLength(1);
    expect(h.slack.updates[0]).toMatchObject({ channel: card?.channel, ts: card?.ts });
    expect(JSON.stringify(h.slack.updates[0]?.blocks)).toContain("`urgent`");
    // One reply: the request's own, not also the generic handoff.
    expect(threadReplies(h)).toEqual([
      {
        channel: card?.channel,
        thread_ts: card?.ts,
        text: "<@UBOB> — alice re-requested your review 👀.\n> Addressed it",
      },
    ]);
    expect(await h.record(101)).toMatchObject({ state: "awaiting_review", note: "Addressed it" });
  });

  it("says 'requested' for reviewers new to the PR, and keeps the earlier note when none is given", async () => {
    const h = prApp();
    await reviewedByBob(h);
    await submit(h, { reviewers: ["UCAROL"] }, "UBOB");
    await drain(h);
    expect(threadReplies(h).map((post) => post.text)).toEqual(["<@UCAROL> — bob requested your review 👀."]);
    expect(await h.record(101)).toMatchObject({ note: "First pass", submittedBy: "UBOB", modifiers: [] });
  });

  it("names an unmapped submitter by their Slack name and posts nothing when only they were requested", async () => {
    const h = prApp();
    await reviewedByBob(h);
    h.slack.names.set("UOUTSIDER", "Olive");
    await h.runJob("post_review_request", request({ submittedBy: "UOUTSIDER" }));
    expect(threadReplies(h).map((post) => post.text)).toEqual(["<@UBOB> — Olive re-requested your review 👀."]);

    h.slack.posts.length = 0;
    await h.runJob("post_review_request", request({ submittedBy: "UBOB" }));
    expect(threadReplies(h)).toEqual([]);
  });

  it("adds a re-request's modifiers to the PR's labels, never removing any", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    await submit(h, { modifiers: ["urgent"] });
    await drain(h);
    await submit(h, { modifiers: [] });
    await drain(h);
    expect(await h.record(101)).toMatchObject({ modifiers: ["urgent"] });

    await submit(h, { modifiers: ["quick"] });
    await drain(h);
    expect(h.github.labelRequests.map((write) => write.labels)).toEqual([["urgent"], ["quick"]]);
    expect(await h.record(101)).toMatchObject({ modifiers: ["quick", "urgent"] });
  });

  it("drops a modifier once its label is removed on GitHub", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    await submit(h, { modifiers: ["quick", "urgent"] });
    await drain(h);
    const pr = h.github.prs[0];
    h.github.upsert({ ...aPR(), pendingReviewers: pr?.pendingReviewers ?? [], labels: ["quick"] });
    h.clock.advance({ minutes: 5 });
    await h.refresh(101);
    expect(await h.record(101)).toMatchObject({ modifiers: ["quick"] });
    expect(JSON.stringify(h.slack.updates.at(-1)?.blocks)).not.toContain("`urgent`");
  });

  it("doesn't reply when the PR is no longer open", async () => {
    const h = prApp();
    await reviewedByBob(h);
    h.github.upsert(aPR({ state: "merged" }));
    await h.runJob("post_review_request", request());
    expect(threadReplies(h)).toEqual([]);
  });

  it("falls back to 'Someone' when the submitter's name can't be read", async () => {
    const h = prApp();
    await reviewedByBob(h);
    vi.spyOn(h.slack, "userName").mockRejectedValue(new Error("users.info failed"));
    await h.runJob("post_review_request", request({ submittedBy: "UOUTSIDER" }));
    expect(threadReplies(h).map((post) => post.text)).toEqual(["<@UBOB> — Someone re-requested your review 👀."]);
  });
});

describe("Request PR: failures", () => {
  it("tells the submitter at once when GitHub turns the request down, without retrying", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    vi.spyOn(h.github.writer, "requestReviewers").mockRejectedValue(
      new GitHubApiError("Reviews may only be requested from collaborators.", 422),
    );
    expect(await h.runJob("request_review", request())).toEqual({ kind: "ack" });
    expect(h.queue.sent).toEqual([]);
    expect(h.slack.dms).toHaveLength(1);
    expect(h.slack.dms[0]?.userId).toBe("UALICE");
    expect(h.slack.dms[0]?.message.text).toContain("Reviews may only be requested from collaborators.");
    expect(h.slack.dms[0]?.message.text).toContain("Nothing was requested");
  });

  it("doesn't add the labels when GitHub turns the reviewers down", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    vi.spyOn(h.github.writer, "requestReviewers").mockRejectedValue(new GitHubApiError("Not a collaborator.", 422));
    await h.runJob("request_review", request({ modifiers: ["urgent"] }));
    expect(h.github.labelRequests).toEqual([]);
  });

  it("goes ahead without the labels GitHub turns down, and tells the submitter", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    vi.spyOn(h.github.writer, "addLabels").mockRejectedValue(new GitHubApiError("Resource not accessible.", 403));
    expect(await h.runJob("request_review", request({ modifiers: ["quick", "urgent"] }))).toEqual({ kind: "ack" });
    expect(h.queue.jobNames()).toEqual(["pr_management.post_review_request"]);
    expect(h.slack.dms[0]?.message.text).toMatch(
      /requested the reviews on .*, but GitHub wouldn't add the labels `quick`, `urgent`: Resource not accessible\.\nAdd them on GitHub/,
    );
  });

  it("still hands over to Slack when the labels-rejected DM fails", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    vi.spyOn(h.github.writer, "addLabels").mockRejectedValue(new GitHubApiError("Validation failed.", 422));
    vi.spyOn(h.slack, "sendDirectMessage").mockRejectedValue(new Error("im_disabled"));
    expect(await h.runJob("request_review", request({ modifiers: ["urgent"] }))).toEqual({ kind: "ack" });
    expect(h.queue.jobNames()).toEqual(["pr_management.post_review_request"]);
    expect(h.log.at("warn").map((entry) => entry.msg)).toContain(
      "Couldn't tell the submitter their labels were turned down",
    );
  });

  it("retries when the labels fail, and on give-up says the reviewers were requested but the labels weren't added", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    vi.spyOn(h.github.writer, "addLabels").mockRejectedValue(new Error("socket hang up"));
    expect((await h.runJob("request_review", request({ modifiers: ["urgent"] }))).kind).toBe("retry");
    expect(await h.runJob("request_review", request({ modifiers: ["urgent"] }), 3)).toEqual({ kind: "ack" });
    expect(h.queue.sent).toEqual([]);
    expect(h.github.reviewerRequests).toHaveLength(2);
    const text = h.slack.dms[0]?.message.text ?? "";
    expect(text).toMatch(
      new RegExp(
        `requested the reviews on .* on GitHub, but couldn't add the labels \`urgent\` \\(socket hang up\\), so I didn't post it in <#${PR_CHANNEL}>`,
      ),
    );
    expect(text).not.toContain("Nothing was requested");
  });

  it("retries when the rejection DM fails, and on give-up still says GitHub turned it down", async () => {
    const h = prApp();
    vi.spyOn(h.github.writer, "requestReviewers").mockRejectedValue(new GitHubApiError("Not a collaborator.", 422));
    const dm = vi.spyOn(h.slack, "sendDirectMessage").mockRejectedValueOnce(new Error("im_disabled"));
    expect((await h.runJob("request_review", request())).kind).toBe("retry");

    dm.mockRejectedValueOnce(new Error("im_disabled"));
    expect(await h.runJob("request_review", request(), 3)).toEqual({ kind: "ack" });
    expect(h.slack.dms[0]?.message.text).toMatch(/GitHub turned down .*Not a collaborator\.\nNothing was requested/);
  });

  it("on give-up after GitHub accepted but the Slack step couldn't be queued, says the reviewers were requested", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    h.queue.fail(new Error("queue unavailable"));
    expect((await h.runJob("request_review", request())).kind).toBe("retry");
    expect(await h.runJob("request_review", request(), 3)).toEqual({ kind: "ack" });
    const text = h.slack.dms[0]?.message.text ?? "";
    expect(text).toMatch(/requested the reviews on .* on GitHub, but couldn't post it .*queue unavailable/);
    expect(text).not.toContain("Nothing was requested");
  });

  it("retries a GitHub outage, then tells the submitter nothing was requested", async () => {
    const h = prApp();
    h.github.fail(new Error("github is down"));
    expect((await h.runJob("request_review", request())).kind).toBe("retry");
    expect(h.slack.dms).toEqual([]);

    expect(await h.runJob("request_review", request(), 3)).toEqual({ kind: "ack" });
    expect(h.slack.dms[0]?.message.text).toMatch(
      /couldn't request reviews on .*github is down.*\nNothing was requested/,
    );
  });

  it("retries only the Slack step, then tells the submitter the reviewers were requested", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    await h.runJob("request_review", request());
    expect(h.queue.jobNames()).toEqual(["pr_management.post_review_request"]);
    h.queue.take();

    vi.spyOn(h.slack, "postMessage").mockRejectedValue(new Error("channel_not_found"));
    expect((await h.runJob("post_review_request", request())).kind).toBe("retry");
    expect(await h.runJob("post_review_request", request(), 3)).toEqual({ kind: "ack" });
    expect(h.github.reviewerRequests).toHaveLength(1);
    expect(h.slack.dms[0]?.message.text).toMatch(
      new RegExp(
        `requested the reviews on .* on GitHub, but couldn't post it in <#${PR_CHANNEL}> \\(channel_not_found\\)`,
      ),
    );
  });

  it("retries when a newer refresh overtook the request, so its fields are still stored", async () => {
    const h = prApp();
    h.github.upsert(aPR());
    h.clock.advance({ minutes: 5 });
    await h.refresh(101);
    h.clock.advance({ minutes: -5 });
    expect((await h.runJob("post_review_request", request({ note: "late" }))).kind).toBe("retry");

    h.clock.advance({ minutes: 10 });
    await h.runJob("post_review_request", request({ note: "late" }));
    expect(await h.record(101)).toMatchObject({ note: "late" });
  });

  it("finalizes a PR that vanished before the Slack step, posting nothing", async () => {
    const h = prApp();
    await h.runJob("post_review_request", request());
    expect(await h.record(101)).toBeNull();
    expect(h.slack.posts).toEqual([]);
  });
});
