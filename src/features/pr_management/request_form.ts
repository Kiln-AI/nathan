import { z } from "zod";
import { normalizeGithubLogin, type UserDirectory } from "../../core/directory";
import type { Logger } from "../../core/log";
import type { PRData } from "../../github";
import {
  checkboxes,
  input,
  type ModalView,
  modal,
  multiUsersSelect,
  textInput,
  urlInput,
  type ViewValues,
} from "../../slack";
import { isWipTitle } from "./status";

// The Request PR form (spec §4.3A): the modal, and validation that runs inside Slack's ack.

/** The global shortcut's callback_id, as in the Slack manifests. */
export const REQUEST_PR_SHORTCUT = "request_pr";
export const REQUEST_PR_VIEW = "request_pr_form";
/** Opens the form from a button (App Home, daily report). */
export const OPEN_REQUEST_PR_ACTION = "request_pr_open";

export const MODIFIERS = ["quick", "large", "urgent"] as const;
export type Modifier = (typeof MODIFIERS)[number];

/** Each input's block_id, which is also its action_id. Inline errors are keyed by block_id. */
export const FIELD = { url: "pr_url", modifiers: "modifiers", reviewers: "reviewers", note: "note" } as const;

/**
 * Slack's ack deadline is 3 seconds, including the network and authorize. The GitHub read and the
 * reviewer name lookups share this budget; past it the form shows a "try again" error.
 */
export const REQUEST_VALIDATION_TIMEOUT_MS = 1800;
export const MAX_NOTE_LENGTH = 2000;

export const reviewRequestSchema = z.object({
  /** The configured spelling of the repo. */
  repo: z.string().min(1),
  number: z.number().int().positive(),
  /** GitHub logins, never including the PR's author. */
  reviewers: z.array(z.string().min(1)).min(1),
  modifiers: z.array(z.enum(MODIFIERS)),
  note: z.string().nullable(),
  /** Slack user ID. */
  submittedBy: z.string().min(1),
});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export const MESSAGES = {
  notAPullRequest: "That isn't a GitHub PR link. Paste one like https://github.com/owner/repo/pull/123.",
  untracked: (repo: string, tracked: readonly string[]) =>
    `I don't track ${repo}. Tracked repos: ${tracked.join(", ")}.`,
  notFound: "I couldn't find that PR on GitHub. Check the link.",
  merged: "That PR is already merged.",
  closed: "That PR is closed. Reopen it on GitHub first.",
  draft: "This PR is a draft. Mark it ready for review on GitHub first.",
  wip: "Title still says WIP. Update it on GitHub first.",
  noReviewers: "Pick at least one reviewer.",
  unmapped: (names: string[]) =>
    `${joinNames(names)} ${names.length === 1 ? "has" : "have"} no GitHub mapping, so I can't request their review. ` +
    "Ask a Nathan admin to add them to users in nathan.config.ts (GitHub login and Slack ID).",
  selfReview: "You wrote this PR, so you can't review it. Pick someone else.",
  authorReview: (author: string) => `${author} wrote this PR, so they can't review it. Pick someone else.`,
  githubTimeout: "GitHub didn't answer in time. Try again.",
  githubFailed: "I couldn't reach GitHub. Try again in a minute.",
  queueFailed: "Something went wrong saving your request. Try again.",
};

const MODIFIER_OPTIONS: Record<Modifier, { text: string; description: string }> = {
  quick: { text: "quick", description: "Small; a few minutes to review" },
  large: { text: "large", description: "Big; set aside some time" },
  urgent: { text: "urgent", description: "Blocking something; reminders come sooner" },
};

export function requestModal(): ModalView {
  return modal({
    callbackId: REQUEST_PR_VIEW,
    title: "Request PR review",
    submit: "Request review",
    close: "Cancel",
    blocks: [
      input({
        blockId: FIELD.url,
        label: "PR link",
        element: urlInput({ actionId: FIELD.url, placeholder: "https://github.com/owner/repo/pull/123" }),
      }),
      input({
        blockId: FIELD.modifiers,
        label: "Modifiers",
        optional: true,
        element: checkboxes({
          actionId: FIELD.modifiers,
          options: MODIFIERS.map((value) => ({ value, ...MODIFIER_OPTIONS[value] })),
        }),
      }),
      input({
        blockId: FIELD.reviewers,
        label: "Reviewers",
        element: multiUsersSelect({ actionId: FIELD.reviewers, placeholder: "Who should review it?" }),
      }),
      input({
        blockId: FIELD.note,
        label: "Note",
        optional: true,
        element: textInput({
          actionId: FIELD.note,
          multiline: true,
          maxLength: MAX_NOTE_LENGTH,
          placeholder: "Anything reviewers should know?",
        }),
      }),
    ],
  });
}

export interface FormInput {
  url: string;
  modifiers: Modifier[];
  reviewerIds: string[];
  note: string | null;
}

export function readSubmission(values: ViewValues): FormInput {
  const field = (id: string) => values[id]?.[id];
  const isModifier = (value: string): value is Modifier => (MODIFIERS as readonly string[]).includes(value);
  const note = field(FIELD.note)?.value?.trim();
  return {
    url: field(FIELD.url)?.value ?? "",
    modifiers: (field(FIELD.modifiers)?.selected_options ?? []).map((o) => o.value).filter(isModifier),
    reviewerIds: field(FIELD.reviewers)?.selected_users ?? [],
    note: note ? note : null,
  };
}

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/** `https://github.com/<owner>/<repo>/pull/<n>`, optionally followed by a path, query or fragment. */
export function parsePullRequestUrl(text: string): { repo: string; number: number } | null {
  const match = PR_URL.exec(text.trim());
  if (!match) return null;
  const number = Number(match[3]);
  return number > 0 ? { repo: `${match[1]}/${match[2]}`, number } : null;
}

export interface ValidationDeps {
  submitterId: string;
  /** The configured spelling of a tracked repo (case-insensitive), else null. */
  trackedRepo(name: string): string | null;
  trackedRepos: readonly string[];
  wipTitlePattern: string;
  directory: Pick<UserDirectory, "bySlack">;
  fetchPullRequest(repo: string, number: number): Promise<PRData | null>;
  slackName(userId: string): Promise<string | null>;
  timeoutMs: number;
  log: Pick<Logger, "warn">;
}

export type Validation = { ok: true; request: ReviewRequest } | { ok: false; errors: Record<string, string> };

const EXPIRED = Symbol("expired");
type PRRead = { pr: PRData | null } | { error: unknown } | typeof EXPIRED;

/**
 * Checks a submission and maps it to a request. Errors are keyed by the field to show them on.
 * Only the GitHub read and Slack name lookups are slow; they run in parallel, under one deadline.
 */
export async function validateRequest(form: FormInput, deps: ValidationDeps): Promise<Validation> {
  const errors: Record<string, string> = {};
  const target = parsePullRequestUrl(form.url);
  const repo = target && deps.trackedRepo(target.repo);
  if (!target) errors[FIELD.url] = MESSAGES.notAPullRequest;
  else if (!repo) errors[FIELD.url] = MESSAGES.untracked(target.repo, deps.trackedRepos);

  const reviewers = form.reviewerIds.map((slackId) => ({ slackId, login: deps.directory.bySlack(slackId)?.github }));
  const unmapped = reviewers.filter((reviewer) => reviewer.login === undefined).map((reviewer) => reviewer.slackId);

  const deadline = startDeadline(deps.timeoutMs);
  const [read, unmappedNames] = await Promise.all([
    target && repo ? deadline.race(readPullRequest(deps, repo, target.number)) : null,
    Promise.all(
      unmapped.map(async (slackId) => {
        const name = await deadline.race(deps.slackName(slackId).catch(() => null));
        return name === EXPIRED || !name ? slackId : name;
      }),
    ),
  ]);
  deadline.clear();

  let pr: PRData | null = null;
  if (read === EXPIRED) {
    deps.log.warn("GitHub didn't answer in time while validating a review request", { url: form.url });
    errors[FIELD.url] = MESSAGES.githubTimeout;
  } else if (read && "error" in read) {
    deps.log.warn("GitHub failed while validating a review request", { url: form.url, error: read.error });
    errors[FIELD.url] = MESSAGES.githubFailed;
  } else if (read) {
    pr = read.pr;
    const problem = pullRequestProblem(pr, deps.wipTitlePattern);
    if (problem) errors[FIELD.url] = problem;
  }

  const logins = unique(reviewers.flatMap((reviewer) => (reviewer.login ? [reviewer.login] : [])));
  const author = pr?.author;
  const requested = author ? logins.filter((login) => !sameLogin(login, author)) : logins;
  if (form.reviewerIds.length === 0) errors[FIELD.reviewers] = MESSAGES.noReviewers;
  else if (unmapped.length > 0) errors[FIELD.reviewers] = MESSAGES.unmapped(unmappedNames);
  else if (author && requested.length === 0) {
    const submitter = deps.directory.bySlack(deps.submitterId)?.github;
    errors[FIELD.reviewers] =
      submitter && sameLogin(submitter, author) ? MESSAGES.selfReview : MESSAGES.authorReview(author);
  }

  if (Object.keys(errors).length > 0 || !repo || !target) return { ok: false, errors };
  return {
    ok: true,
    request: {
      repo,
      number: target.number,
      reviewers: requested,
      modifiers: form.modifiers,
      note: form.note,
      submittedBy: deps.submitterId,
    },
  };
}

async function readPullRequest(deps: ValidationDeps, repo: string, number: number): Promise<PRRead> {
  try {
    return { pr: await deps.fetchPullRequest(repo, number) };
  } catch (error) {
    return { error };
  }
}

function pullRequestProblem(pr: PRData | null, wipTitlePattern: string): string | null {
  if (!pr) return MESSAGES.notFound;
  if (pr.state === "merged") return MESSAGES.merged;
  if (pr.state === "closed") return MESSAGES.closed;
  // Nathan never un-drafts or retitles PRs.
  if (pr.isDraft) return MESSAGES.draft;
  if (isWipTitle(pr.title, wipTitlePattern)) return MESSAGES.wip;
  return null;
}

function startDeadline(ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), ms);
  });
  return {
    race: <T>(work: Promise<T>): Promise<T | typeof EXPIRED> => Promise.race([work, expired]),
    clear: () => clearTimeout(timer),
  };
}

function unique(logins: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const login of logins)
    if (!byKey.has(normalizeGithubLogin(login))) byKey.set(normalizeGithubLogin(login), login);
  return [...byKey.values()];
}

function sameLogin(a: string, b: string): boolean {
  return normalizeGithubLogin(a) === normalizeGithubLogin(b);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
