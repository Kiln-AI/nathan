import type { DateTime } from "luxon";
import { normalizeGithubLogin } from "../../core/directory";
import { formatAge } from "../../core/time";
import type { PRData } from "../../github";
import { context, escapeText, link, type MessageBlock, mention, section, truncate } from "../../slack";
import type { People } from "./people";
import { type PRStatusState, STATE_INFO } from "./status";

// The live card (spec §4.4): one top-level message per PR in the PR channel, edited in place.

export type ReviewerStatus = "pending" | "approved" | "changes_requested" | "commented";

export interface ReviewerLine {
  /** A GitHub login, or a team slug when `team` is set. */
  login: string;
  status: ReviewerStatus;
  team?: boolean;
}

export interface CardModel {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  additions: number;
  deletions: number;
  createdAt: DateTime;
  state: PRStatusState;
  owners: readonly string[];
  reviewers: readonly ReviewerLine[];
  modifiers: readonly string[];
  note: string | null;
  /** Slack user who requested the review through the form; GitHub-originated cards credit the author. */
  submittedBy: string | null;
}

export interface RenderedCard {
  text: string;
  blocks: MessageBlock[];
}

const REVIEWER_EMOJI: Record<ReviewerStatus, string> = {
  pending: "⏳",
  approved: "✅",
  changes_requested: "🔁",
  commented: "💬",
};

/** Pending reviewers (people, then teams), then everyone else's latest review. Dismissed reviews and the author's own are left out. */
export function reviewerLines(pr: PRData): ReviewerLine[] {
  const isAuthor = (login: string) => normalizeGithubLogin(login) === normalizeGithubLogin(pr.author);
  const pending = new Set(pr.pendingReviewers.map(normalizeGithubLogin));
  const lines: ReviewerLine[] = [
    ...pr.pendingReviewers.filter((login) => !isAuthor(login)).map((login) => pendingLine(login)),
    ...pr.pendingTeams.map((slug) => pendingLine(slug, true)),
  ];
  for (const review of pr.reviews) {
    if (review.state === "dismissed" || isAuthor(review.author) || pending.has(normalizeGithubLogin(review.author))) {
      continue;
    }
    lines.push({ login: review.author, status: review.state });
  }
  return lines;
}

function pendingLine(login: string, team = false): ReviewerLine {
  return team ? { login, status: "pending", team } : { login, status: "pending" };
}

export function renderCard(model: CardModel, people: People, now: DateTime): RenderedCard {
  const info = STATE_INFO[model.state];
  const title = `*${link(model.url, `${model.repo}#${model.number}`)}* ${escapeText(model.title)}`;
  const age = formatAge(now.diff(model.createdAt).as("hours"));
  const details = [
    `by ${people.label(model.author)}`,
    `+${model.additions} −${model.deletions}`,
    `opened ${age} ago`,
    ...model.modifiers.map((modifier) => `\`${modifier}\``),
  ];

  const blocks: MessageBlock[] = [section(title), context(details.join(" · "))];
  if (model.note) blocks.push(section(quote(model.note)));
  if (model.reviewers.length > 0) {
    const reviewers = model.reviewers.map(
      (r) => `${REVIEWER_EMOJI[r.status]} ${r.team ? `${escapeText(r.login)} (team)` : people.label(r.login)}`,
    );
    blocks.push(section(`*Reviewers:* ${reviewers.join("   ")}`));
  }
  blocks.push(section(statusLine(model, people)));
  const requester = model.submittedBy ? mention(model.submittedBy) : people.label(model.author);
  blocks.push(context(`Requested by ${requester}`));

  return { text: `${model.repo}#${model.number} ${escapeText(model.title)}: ${info.label}`, blocks };
}

function statusLine(model: CardModel, people: People): string {
  const info = STATE_INFO[model.state];
  const heading = `${info.emoji} *${info.label}*`;
  if (info.nextStep === null) return heading;
  const ownerLabel = model.owners.length === 1 ? "Owner" : "Owners";
  const owners = model.owners.map((login) => people.label(login)).join(", ");
  return `${heading} · Next: ${info.nextStep} · ${ownerLabel}: ${owners}`;
}

/** Titles longer than this are shortened in lists (the card itself shows the whole title). */
export const MAX_LISTED_TITLE = 80;

/** "<link|repo#n> title" for one line in a list of PRs. */
export function prListTitle(pr: { url: string; repo: string; number: number; title: string }): string {
  return `${link(pr.url, `${pr.repo}#${pr.number}`)} ${escapeText(truncate(pr.title, MAX_LISTED_TITLE))}`;
}

/** Escaped and quoted line by line, as mrkdwn. */
export function quote(text: string): string {
  return escapeText(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
