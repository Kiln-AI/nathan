import type { DateTime } from "luxon";
import { formatAge } from "../../core/time";
import { context, escapeText, link, type MessageBlock, mention, section, truncate } from "../../slack";
import type { People } from "./people";
import type { ReviewerLine, ReviewerStatus } from "./reviewers";
import { type PRStatusState, STATE_INFO } from "./status";

// The live card (spec §4.4): one top-level message per PR in the PR channel, edited in place.

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

export const REVIEWER_EMOJI: Record<ReviewerStatus, string> = {
  pending: "⏳",
  approved: "✅",
  changes_requested: "🔁",
  commented: "💬",
};

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
  const owners = ownersText(model.owners.map((login) => people.label(login)));
  return [heading, `Next: ${info.nextStep}`, ...(owners ? [owners] : [])].join(" · ");
}

/** "Owner: a" or "Owners: a, b"; null when nobody owns the PR (it's in a merge queue). */
export function ownersText(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  return `${labels.length === 1 ? "Owner" : "Owners"}: ${labels.join(", ")}`;
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
