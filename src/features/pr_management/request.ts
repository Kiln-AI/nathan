import { normalizeGithubLogin } from "../../core/directory";
import { errorMessage } from "../../core/errors";
import type { Registrar } from "../../core/feature";
import type { JobRef } from "../../core/jobs";
import { GitHubApiError, type PRData } from "../../github";
import { button, channelLink, escapeText, type HomeBlock, link, mention, section, truncate } from "../../slack";
import { quote } from "./card";
import type { PRConfig } from "./config";
import { type PRContext, refreshPullRequest } from "./refresh";
import {
  FIELD,
  MESSAGES,
  OPEN_REQUEST_PR_ACTION,
  REQUEST_PR_SHORTCUT,
  REQUEST_PR_VIEW,
  REQUEST_VALIDATION_TIMEOUT_MS,
  type ReviewRequest,
  readSubmission,
  requestModal,
  reviewRequestSchema,
  validateRequest,
} from "./request_form";
import { trackedRepos } from "./webhooks";

// Request PR (spec §4.3A): the form's entry points, and the jobs that carry out a submission.
//
// The architecture has one `request_review` job. It is split in two so a Slack failure retries
// only the Slack step, and each give-up knows how far the request got (spec §5: partial work is
// reported): `request_review` writes to GitHub, then `post_review_request` brings Slack in line.

/** GitHub refused the request (e.g. 422: a reviewer isn't a collaborator). Retrying won't help. */
const REJECTED_STATUSES = new Set([403, 404, 422]);
const MAX_ERROR_IN_DM = 300;

export const HOME_TEXT = "*Need a review?* Request one and I'll post it to the PR channel and keep it moving.";

export function registerRequestPR(registrar: Registrar<PRConfig>, ctx: PRContext): void {
  const { config, services } = ctx;
  const tracked = trackedRepos(config.repos);
  const openForm = async ({ triggerId }: { triggerId: string }) => {
    await services.slack.openView(triggerId, requestModal());
  };

  const post = registrar.jobs.define(
    "post_review_request",
    reviewRequestSchema,
    (request) => postReviewRequest(ctx, request),
    { onGiveUp: (request, error) => tellSubmitter(ctx, request, slackGaveUpText(request, config.channel, error)) },
  );
  const requestJob = registrar.jobs.define(
    "request_review",
    reviewRequestSchema,
    (request) => requestReviewers(ctx, post, request),
    { onGiveUp: (request, error) => tellSubmitter(ctx, request, requestGaveUpText(request, config.channel, error)) },
  );

  registrar.slack.shortcut(REQUEST_PR_SHORTCUT, { ack: openForm });
  registrar.slack.action(OPEN_REQUEST_PR_ACTION, { ack: openForm });
  registrar.slack.homeSection({ order: 0, render: async () => requestHomeSection() });

  registrar.slack.viewSubmission(REQUEST_PR_VIEW, {
    ack: async ({ userId, values }) => {
      const result = await validateRequest(readSubmission(values), {
        submitterId: userId,
        trackedRepo: tracked,
        trackedRepos: config.repos,
        wipTitlePattern: config.wipTitlePattern,
        directory: services.directory,
        fetchPullRequest: (repo, number) => services.github.reader.pullRequest(repo, number),
        slackName: (slackId) => services.slack.userName(slackId),
        timeoutMs: REQUEST_VALIDATION_TIMEOUT_MS,
        log: services.log,
      });
      if (!result.ok) return { errors: result.errors };
      // Queued before the modal closes, so an accepted request is never lost.
      try {
        await services.enqueue(requestJob, result.request);
      } catch (error) {
        services.log.error("Couldn't queue a review request", { error, request: result.request });
        return { errors: { [FIELD.url]: MESSAGES.queueFailed } };
      }
    },
  });
}

export function requestHomeSection(): HomeBlock[] {
  return [
    section(HOME_TEXT, {
      accessory: button({ text: "Request PR", actionId: OPEN_REQUEST_PR_ACTION, style: "primary" }),
    }),
  ];
}

/** GitHub accepted the reviewers, but handing over to the Slack step failed. */
export class ReviewersRequestedError extends Error {
  override name = "ReviewersRequestedError";

  constructor(readonly reason: unknown) {
    super(`Reviewers were requested, but the Slack step couldn't be queued: ${errorMessage(reason)}`);
  }
}

/** GitHub turned the request down, but telling the submitter failed. */
export class RejectionNotDeliveredError extends Error {
  override name = "RejectionNotDeliveredError";

  constructor(
    readonly rejection: GitHubApiError,
    readonly reason: unknown,
  ) {
    super(`GitHub rejected a review request, and the DM saying so failed: ${errorMessage(reason)}`);
  }
}

/**
 * The `request_review` job: adds the reviewers on GitHub (never removing anyone), then hands over to
 * Slack. Failures after the GitHub call are marked, so the give-up DM says what GitHub did.
 */
export async function requestReviewers(ctx: PRContext, post: JobRef<ReviewRequest>, request: ReviewRequest) {
  const { services } = ctx;
  try {
    await services.github.writer.requestReviewers(request.repo, request.number, request.reviewers);
  } catch (error) {
    if (!(error instanceof GitHubApiError && REJECTED_STATUSES.has(error.status))) throw error;
    services.log.warn("GitHub rejected a review request", { request, error });
    try {
      await tellSubmitter(ctx, request, githubRejectedText(request, error));
    } catch (dmError) {
      throw new RejectionNotDeliveredError(error, dmError);
    }
    return;
  }
  try {
    await services.enqueue(post, request);
  } catch (error) {
    throw new ReviewersRequestedError(error);
  }
}

/**
 * The `post_review_request` job: stores the form's fields and brings the card up to date. A first
 * request posts the card, which tags the reviewers; a re-request also replies in the card's thread.
 */
export async function postReviewRequest(ctx: PRContext, request: ReviewRequest): Promise<void> {
  const { services, store } = ctx;
  const { repo, number } = request;
  const existingCard = (await store.get(repo, number))?.card;
  const readAt = services.clock.now();
  const pr = await services.github.reader.pullRequest(repo, number);
  const fields = { modifiers: request.modifiers, note: request.note, submittedBy: request.submittedBy };
  await refreshPullRequest(ctx, repo, number, pr ? { pr, readAt } : undefined, fields);
  // No re-request reply on a PR that can't be reviewed any more; the card update is enough.
  if (!existingCard || !pr || pr.state !== "open" || pr.isDraft) return;

  const reply = reRequestReply({ request, pr, actor: await actorName(ctx, request.submittedBy), ctx });
  if (reply)
    await services.slack.postMessage({ channel: existingCard.channel, thread_ts: existingCard.ts, text: reply });
}

/** Tags the reviewers (never the submitter, who acted) with who asked, and the note. */
export function reRequestReply({
  request,
  pr,
  actor,
  ctx,
}: {
  request: ReviewRequest;
  pr: PRData;
  actor: string;
  ctx: Pick<PRContext, "people">;
}): string | null {
  const tags = ctx.people.tags(request.reviewers).filter((tag) => tag !== mention(request.submittedBy));
  if (tags.length === 0) return null;
  const reviewedBefore = request.reviewers.some((login) =>
    pr.reviews.some((review) => normalizeGithubLogin(review.author) === normalizeGithubLogin(login)),
  );
  const sentence = `${tags.join(" ")} — ${escapeText(actor)} ${reviewedBefore ? "re-requested" : "requested"} your review 👀.`;
  return request.note ? `${sentence}\n${quote(request.note)}` : sentence;
}

/** How the submitter is named without pinging them: their GitHub login, else their Slack name. */
async function actorName(ctx: PRContext, slackId: string): Promise<string> {
  const login = ctx.services.directory.bySlack(slackId)?.github;
  if (login) return login;
  const name = await ctx.services.slack.userName(slackId).catch(() => null);
  return name ?? "Someone";
}

async function tellSubmitter(ctx: PRContext, request: ReviewRequest, text: string): Promise<void> {
  await ctx.services.slack.sendDirectMessage(request.submittedBy, { text });
}

function prLink({ repo, number }: ReviewRequest): string {
  return link(`https://github.com/${repo}/pull/${number}`, `${repo}#${number}`);
}

function detail(error: unknown): string {
  return escapeText(truncate(errorMessage(error), MAX_ERROR_IN_DM));
}

export function githubRejectedText(request: ReviewRequest, error: unknown): string {
  return `GitHub turned down your review request for ${prLink(request)}: ${detail(error)}\nNothing was requested. Fix that on GitHub, then try again.`;
}

/** The `request_review` give-up DM, saying how far the request got. */
export function requestGaveUpText(request: ReviewRequest, channel: string, error: unknown): string {
  if (error instanceof ReviewersRequestedError) return slackGaveUpText(request, channel, error.reason);
  if (error instanceof RejectionNotDeliveredError) return githubRejectedText(request, error.rejection);
  return githubGaveUpText(request, error);
}

export function githubGaveUpText(request: ReviewRequest, error: unknown): string {
  return `I couldn't request reviews on ${prLink(request)}: GitHub kept failing (${detail(error)}).\nNothing was requested. Please try again.`;
}

export function slackGaveUpText(request: ReviewRequest, channel: string, error: unknown): string {
  return (
    `I requested the reviews on ${prLink(request)} on GitHub, but couldn't post it in ${channelLink(channel)} (${detail(error)}).\n` +
    "The hourly sweep will bring its card up to date."
  );
}
