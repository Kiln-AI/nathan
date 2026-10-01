import type { DateTime } from "luxon";
import { normalizeGithubLogin } from "../../core/directory";
import type { Registrar } from "../../core/feature";
import { formatAge } from "../../core/time";
import {
  context,
  escapeText,
  MAX_MESSAGE_BLOCKS,
  type MessageBlock,
  type SectionBlock,
  section,
  sectionsFromLines,
} from "../../slack";
import { ownersText, prListTitle } from "./card";
import type { PRConfig } from "./config";
import type { People } from "./people";
import type { PRContext } from "./refresh";
import { isFinal, STATE_INFO } from "./status";
import type { PRRecord } from "./store";

// The personal queue (spec §4.9): what's waiting on you, and your own open PRs. Shown on the App
// Home (refreshed whenever the tab opens) and by `/nathan prs`.

export const PRS_COMMAND = "prs";
/** After the Request PR section (order 0). */
export const QUEUE_HOME_ORDER = 10;

export const UNMAPPED_TEXT =
  "I don't know your GitHub login, so I can't show your PRs. Ask a Nathan admin to add you to `users` " +
  "in nathan.config.ts (your GitHub login and Slack ID).";
export const NOTHING_WAITING_TEXT = "Nothing's waiting on you 🎉";
export const NO_OPEN_PRS_TEXT = "You have no open PRs.";
export const QUEUE_TRUNCATED_TEXT =
  "_Some PRs are hidden: a message holds only 50 blocks. My App Home tab has them all._";

export interface PersonalQueue {
  text: string;
  blocks: SectionBlock[];
}

/**
 * "Waiting on you": open, non-draft PRs the user owns, grouped by next step, longest-waiting first
 * (drafts aren't waiting on anyone; they're under "Your open PRs"). "Your open PRs": every open PR
 * they wrote, oldest first, with its state and owners.
 */
export function personalQueue(input: {
  /** The user's GitHub login, or null when they have no mapping. */
  login: string | null;
  records: readonly PRRecord[];
  now: DateTime;
  people: People;
}): PersonalQueue {
  const { login, now, people } = input;
  if (login === null) return { text: UNMAPPED_TEXT, blocks: [section(UNMAPPED_TEXT)] };
  const key = normalizeGithubLogin(login);
  const is = (other: string) => normalizeGithubLogin(other) === key;
  const open = input.records.filter((record) => !isFinal(record.state));
  const waiting = open
    .filter((record) => record.state !== "draft" && record.owners.some(is))
    .sort((a, b) => a.stateSince.toMillis() - b.stateSince.toMillis());
  const mine = open
    .filter((record) => is(record.author))
    .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());

  return {
    text: `${waiting.length} waiting on you, ${mine.length} of yours open`,
    blocks: [...sectionsFromLines(waitingLines(waiting, now)), ...sectionsFromLines(mineLines(mine, now, people))],
  };
}

export function registerPersonalQueue(registrar: Registrar<PRConfig>, ctx: PRContext): void {
  const { config, services, store, people } = ctx;
  const queueFor = async (userId: string) => {
    const login = services.directory.bySlack(userId)?.github ?? null;
    const records = login === null ? [] : await store.openRecords(config.repos);
    return personalQueue({ login, records, now: services.clock.now(), people });
  };

  registrar.slack.homeSection({
    order: QUEUE_HOME_ORDER,
    render: async ({ userId }) => (await queueFor(userId)).blocks,
  });
  registrar.slack.command(PRS_COMMAND, {
    description: "Show the PRs waiting on you, and your open PRs",
    lazy: async (request) => {
      const queue = await queueFor(request.userId);
      await request.respond({ text: queue.text, blocks: fitMessage(queue.blocks) });
    },
  });
}

/** The App Home holds 100 blocks, a message 50: cut to fit, saying so. */
export function fitMessage(blocks: readonly MessageBlock[]): MessageBlock[] {
  if (blocks.length <= MAX_MESSAGE_BLOCKS) return [...blocks];
  return [...blocks.slice(0, MAX_MESSAGE_BLOCKS - 1), context(QUEUE_TRUNCATED_TEXT)];
}

function waitingLines(waiting: readonly PRRecord[], now: DateTime): string[] {
  if (waiting.length === 0) return ["*Waiting on you*", NOTHING_WAITING_TEXT];
  // Groups appear in the order of their longest-waiting PR.
  const groups = new Map<string, PRRecord[]>();
  for (const record of waiting) {
    const step = STATE_INFO[record.state].nextStep ?? "";
    groups.set(step, [...(groups.get(step) ?? []), record]);
  }
  return [
    `*Waiting on you* (${waiting.length})`,
    ...[...groups].flatMap(([step, records]) => [
      `*${step}*`,
      ...records.map(
        (record) =>
          `• ${prListTitle(record)} · by ${escapeText(record.author)} · waiting ${formatAge(hoursSince(record.stateSince, now))}`,
      ),
    ]),
  ];
}

function mineLines(mine: readonly PRRecord[], now: DateTime, people: People): string[] {
  if (mine.length === 0) return ["*Your open PRs*", NO_OPEN_PRS_TEXT];
  return [
    `*Your open PRs* (${mine.length})`,
    ...mine.map((record) => {
      const info = STATE_INFO[record.state];
      const owners = ownersText(record.owners.map((login) => people.label(login)));
      return [
        `• ${prListTitle(record)}`,
        `${info.emoji} ${info.label}`,
        ...(owners ? [owners] : []),
        `opened ${formatAge(hoursSince(record.createdAt, now))} ago`,
      ].join(" · ");
    }),
  ];
}

function hoursSince(time: DateTime, now: DateTime): number {
  return now.diff(time).as("hours");
}
