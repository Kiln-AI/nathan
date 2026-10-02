import type { DateTime } from "luxon";
import { normalizeGithubLogin } from "../../core/directory";
import type { Registrar } from "../../core/feature";
import { formatAge } from "../../core/time";
import {
  actions,
  button,
  context,
  divider,
  escapeText,
  type HomeBlock,
  header,
  MAX_MESSAGE_BLOCKS,
  type MessageBlock,
  type RichTextElement,
  richText,
  richTextList,
  section,
  truncate,
} from "../../slack";
import { MAX_LISTED_TITLE } from "./card";
import type { PRConfig } from "./config";
import { prKey } from "./metrics";
import type { People } from "./people";
import type { PRContext } from "./refresh";
import { overdueOwners } from "./reminders";
import { isFinal, type PRStatusState, STATE_INFO } from "./status";
import type { PRRecord } from "./store";

// The personal queue (spec §4.9): what's overdue, what's waiting on you, and your own open PRs.
// Shown on the App Home (refreshed whenever the tab opens, with tabs to filter it) and by
// `/nathan prs`.

export const PRS_COMMAND = "prs";
/** After the Request PR section (order 0). */
export const QUEUE_HOME_ORDER = 10;

export const UNMAPPED_TEXT =
  "I don't know your GitHub login, so I can't show your PRs. Ask a Nathan admin to add you to `users` " +
  "in nathan.config.ts (your GitHub login and Slack ID).";
export const NOTHING_WAITING_TEXT = "Nothing's waiting on you 🎉";
export const NO_OPEN_PRS_TEXT = "You have no open PRs.";
export const NOTHING_OVERDUE_TEXT = "Nothing overdue 🎉";
export const QUEUE_TRUNCATED_TEXT = "_Some PRs are hidden: a message holds only 50 blocks._";
/** Rows shown per group, on the App Home and in `/nathan prs`; the rest are counted ("…and N more"). */
export const MAX_GROUP_ROWS = 30;

export const QUEUE_TABS = ["all", "overdue", "waiting", "mine"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
/** One action_id per tab: Slack requires action_ids to be unique within a view. */
export const queueTabAction = (tab: QueueTab) => `pr_queue_tab_${tab}`;

const OVERDUE_EMOJI = "⏰";
const WAITING_EMOJI = "📥";
const MINE_EMOJI = "🚀";

/** Your open PRs are grouped by state, the ones needing the most action first. */
const MINE_ORDER: readonly PRStatusState[] = [
  "conflict",
  "ci_failing",
  "changes_requested",
  "approved",
  "needs_rerequest",
  "needs_reviewer",
  "wip_title",
  "awaiting_review",
  "in_merge_queue",
  "draft",
];

/** "Waiting on you" counts, phrased as your next action: [one, several]. */
const WAITING_PHRASES: Partial<Record<PRStatusState, [string, string]>> = {
  awaiting_review: ["review requested", "reviews requested"],
  conflict: ["conflict to resolve", "conflicts to resolve"],
  ci_failing: ["CI failing", "CI failing"],
  changes_requested: ["feedback to address", "feedback to address"],
  approved: ["ready to merge", "ready to merge"],
  needs_rerequest: ["to re-request or merge", "to re-request or merge"],
  needs_reviewer: ["needs a reviewer", "need a reviewer"],
  wip_title: ["WIP title", "WIP titles"],
};

export interface QueueItem {
  record: PRRecord;
  /** Waiting on you: you're past the threshold. Your PRs: another owner is. */
  overdue: boolean;
}

export interface QueueGroup {
  title: string;
  items: QueueItem[];
}

export interface StateCount {
  state: PRStatusState;
  count: number;
}

export interface Queue {
  /** By next step, groups in order of their longest-waiting PR, longest waiting first. */
  waiting: QueueGroup[];
  /** By state, most action needed first, longest waiting first. */
  mine: QueueGroup[];
  stats: {
    waiting: { total: number; byState: StateCount[] };
    mine: { total: number; byState: StateCount[] };
    overdue: { total: number; waitingOnYou: number; yoursOnOthers: number; oldestHours: number | null };
  };
}

/** Blocks valid both on the App Home and in a message. */
type QueueBlock = HomeBlock & MessageBlock;

export interface PersonalQueue {
  text: string;
  blocks: MessageBlock[];
}

/** Records the queue for `login` reads: open PRs they own or wrote. */
export function relevantRecords(login: string, records: readonly PRRecord[]): PRRecord[] {
  const is = sameLogin(login);
  return records.filter((record) => !isFinal(record.state) && (is(record.author) || record.owners.some(is)));
}

/**
 * "Waiting on you": open, non-draft PRs the user owns (drafts aren't waiting on anyone; they're
 * under "Your open PRs"). "Your open PRs": every open PR they wrote. Overdue is counted once per
 * PR: waiting on you past the reminder threshold, or your PR with another owner past it.
 */
export function buildQueue(input: {
  login: string;
  records: readonly PRRecord[];
  /** Owners past the reminder threshold, by `prKey` (see `overdueOwners`). */
  overdue: ReadonlyMap<string, readonly string[]>;
  now: DateTime;
}): Queue {
  const { now } = input;
  const is = sameLogin(input.login);
  const open = input.records.filter((record) => !isFinal(record.state));
  const overdueFor = (record: PRRecord) => input.overdue.get(prKey(record)) ?? [];

  const waitingItems = longestWaitingFirst(
    open.filter((record) => record.state !== "draft" && record.owners.some(is)),
  ).map((record) => ({ record, overdue: overdueFor(record).some(is) }));
  const mineItems = longestWaitingFirst(open.filter((record) => is(record.author))).map((record) => ({
    record,
    overdue: overdueFor(record).some((login) => !is(login)),
  }));

  // Groups appear in the order of their longest-waiting PR.
  const waiting = groupBy(waitingItems, (item) => STATE_INFO[item.record.state].nextStep ?? "");
  const mine = MINE_ORDER.map((state) => ({
    state,
    items: mineItems.filter((item) => item.record.state === state),
  }))
    .filter((group) => group.items.length > 0)
    .map(({ state, items }) => ({ title: `${STATE_INFO[state].emoji} ${STATE_INFO[state].label}`, items }));

  const mineCounts = countByState(mineItems);
  const overdueItems = [...waitingItems, ...mineItems].filter((item) => item.overdue);
  const overdueKeys = new Set(overdueItems.map((item) => prKey(item.record)));
  const oldest = overdueItems.map((item) => now.diff(item.record.stateSince).as("hours"));

  return {
    waiting,
    mine,
    stats: {
      waiting: {
        total: waitingItems.length,
        byState: countByState(waitingItems).sort((a, b) => b.count - a.count),
      },
      mine: {
        total: mineItems.length,
        byState: MINE_ORDER.flatMap((state) => mineCounts.filter((count) => count.state === state)),
      },
      overdue: {
        total: overdueKeys.size,
        waitingOnYou: waitingItems.filter((item) => item.overdue).length,
        yoursOnOthers: mineItems.filter((item) => item.overdue).length,
        oldestHours: oldest.length > 0 ? Math.max(...oldest) : null,
      },
    },
  };
}

/** The App Home section: stats, tabs, then the tab's lists. */
export function renderHome(queue: Queue, tab: QueueTab, people: People, login: string, now: DateTime): QueueBlock[] {
  return [
    ...statBlocks(queue),
    divider(),
    tabBlock(queue, tab),
    divider(),
    ...listBlocks(queue, tab, people, login, now),
  ];
}

/** `/nathan prs`: the App Home's All tab, without tabs (they only work on the App Home). */
export function renderQueueMessage(queue: Queue, people: People, login: string, now: DateTime): PersonalQueue {
  const { waiting, mine, overdue } = queue.stats;
  return {
    text: `${waiting.total} waiting on you, ${overdue.total} overdue, ${mine.total} of yours open`,
    blocks: fitMessage([...statBlocks(queue), divider(), ...listBlocks(queue, "all", people, login, now)]),
  };
}

export function registerPersonalQueue(registrar: Registrar<PRConfig>, ctx: PRContext): void {
  const { config, services, store, people } = ctx;
  const queueFor = async (login: string) => {
    const now = services.clock.now();
    const records = relevantRecords(login, await store.openRecords(config.repos));
    return { queue: buildQueue({ login, records, overdue: await overdueOwners(ctx, records, now), now }), now };
  };
  const loginOf = (userId: string) => services.directory.bySlack(userId)?.github ?? null;

  registrar.slack.homeSection({
    order: QUEUE_HOME_ORDER,
    render: async ({ userId, state }) => {
      const login = loginOf(userId);
      if (login === null) return [section(UNMAPPED_TEXT)];
      const { queue, now } = await queueFor(login);
      return renderHome(queue, parseTab(state), people, login, now);
    },
  });
  for (const tab of QUEUE_TABS) registrar.slack.homeButton(queueTabAction(tab));

  registrar.slack.command(PRS_COMMAND, {
    description: "Show the PRs waiting on you, and your open PRs",
    lazy: async (request) => {
      const login = loginOf(request.userId);
      if (login === null) {
        await request.respond({ text: UNMAPPED_TEXT, blocks: [section(UNMAPPED_TEXT)] });
        return;
      }
      const { queue, now } = await queueFor(login);
      await request.respond(renderQueueMessage(queue, people, login, now));
    },
  });
}

export function parseTab(state: string | undefined): QueueTab {
  return QUEUE_TABS.find((tab) => tab === state) ?? "all";
}

/** The App Home holds 100 blocks, a message 50: cut to fit, saying so. */
export function fitMessage(blocks: readonly MessageBlock[]): MessageBlock[] {
  if (blocks.length <= MAX_MESSAGE_BLOCKS) return [...blocks];
  return [...blocks.slice(0, MAX_MESSAGE_BLOCKS - 1), context(QUEUE_TRUNCATED_TEXT)];
}

// ---- Stats and tabs ---------------------------------------------------------------------------

function statBlocks({ stats }: Queue): QueueBlock[] {
  const { overdue, waiting, mine } = stats;
  const overdueParts = [
    ...(overdue.waitingOnYou > 0 ? [`${overdue.waitingOnYou} waiting on you`] : []),
    ...(overdue.yoursOnOthers > 0 ? [`${overdue.yoursOnOthers} of your PRs, waiting on others`] : []),
    ...(overdue.oldestHours === null ? [] : [`oldest ${formatAge(overdue.oldestHours)}`]),
  ];
  return [
    header(`${OVERDUE_EMOJI} ${overdue.total} Overdue`),
    context(overdue.total > 0 ? overdueParts.join(" · ") : NOTHING_OVERDUE_TEXT),
    header(`${WAITING_EMOJI} ${waiting.total} Waiting on You`),
    context(waiting.total > 0 ? waiting.byState.map(waitingPhrase).join(" · ") : NOTHING_WAITING_TEXT),
    header(`${MINE_EMOJI} ${mine.total} Open PRs`),
    context(mine.total > 0 ? mine.byState.map(minePhrase).join(" · ") : NO_OPEN_PRS_TEXT),
  ];
}

function waitingPhrase({ state, count }: StateCount): string {
  const [one, several] = WAITING_PHRASES[state] ?? [STATE_INFO[state].label, STATE_INFO[state].label];
  return `${count} ${count === 1 ? one : several}`;
}

function minePhrase({ state, count }: StateCount): string {
  const { emoji, label } = STATE_INFO[state];
  return `${emoji} ${count} ${lowerFirst(label)}`;
}

/** Every tab is a secondary button, so Request PR stays the only primary one; ✓ marks the current tab. */
function tabBlock({ stats }: Queue, current: QueueTab): QueueBlock {
  const labels: Record<QueueTab, string> = {
    all: "All",
    overdue: `${OVERDUE_EMOJI} Overdue · ${stats.overdue.total}`,
    waiting: `${WAITING_EMOJI} Waiting on You · ${stats.waiting.total}`,
    mine: `${MINE_EMOJI} Your Open PRs · ${stats.mine.total}`,
  };
  return actions(
    QUEUE_TABS.map((tab) =>
      button({ text: `${tab === current ? "✓ " : ""}${labels[tab]}`, actionId: queueTabAction(tab), value: tab }),
    ),
  );
}

// ---- Lists ------------------------------------------------------------------------------------

/** All shows both sections; Overdue shows both, filtered to overdue PRs; the others one section. */
function listBlocks(queue: Queue, tab: QueueTab, people: People, login: string, now: DateTime): QueueBlock[] {
  const overdueOnly = tab === "overdue";
  const waiting = () => waitingSection(queue, overdueOnly, people, login, now);
  const mine = () => mineSection(queue, overdueOnly, people, login, now);
  if (tab === "waiting") return waiting();
  if (tab === "mine") return mine();
  return [...waiting(), divider(), ...mine()];
}

function waitingSection(
  queue: Queue,
  overdueOnly: boolean,
  people: People,
  login: string,
  now: DateTime,
): QueueBlock[] {
  const groups = filterGroups(queue.waiting, overdueOnly);
  const count = countItems(groups);
  const intro = overdueOnly
    ? count > 0
      ? `${count} overdue, by next step, longest waiting first.`
      : NOTHING_OVERDUE_TEXT
    : count > 0
      ? `${count} ${plural(count, "PR")} by next step, longest waiting first.`
      : NOTHING_WAITING_TEXT;
  return [
    header(`${WAITING_EMOJI} Waiting on You`),
    context(intro),
    ...groups.flatMap((group) => groupBlocks(group, overdueOnly, (item) => waitingRow(item, people, login, now))),
  ];
}

function mineSection(queue: Queue, overdueOnly: boolean, people: People, login: string, now: DateTime): QueueBlock[] {
  const groups = filterGroups(queue.mine, overdueOnly);
  const count = countItems(groups);
  const intro = overdueOnly
    ? count > 0
      ? `${count} overdue on someone else.`
      : NOTHING_OVERDUE_TEXT
    : count > 0
      ? `${count} open, most action needed first.`
      : NO_OPEN_PRS_TEXT;
  return [
    header(`${MINE_EMOJI} Your Open PRs`),
    context(intro),
    ...groups.flatMap((group) => groupBlocks(group, overdueOnly, (item) => mineRow(item, people, login, now))),
  ];
}

function groupBlocks(
  group: QueueGroup,
  overdueOnly: boolean,
  row: (item: QueueItem) => RichTextElement[],
): QueueBlock[] {
  const overdue = overdueOnly ? 0 : group.items.filter((item) => item.overdue).length;
  const label = [escapeText(group.title), String(group.items.length), ...(overdue > 0 ? [`${overdue} overdue`] : [])];
  const shown = group.items.slice(0, MAX_GROUP_ROWS);
  const hidden = group.items.length - shown.length;
  const rows = shown.map(row);
  if (hidden > 0) rows.push([richText.text(`…and ${hidden} more`, { italic: true })]);
  return [context(label.join(" · ")), richTextList(rows)];
}

/** "Kiln - #12 Title · @author · 3h"; your own PRs leave out the author. */
function waitingRow(item: QueueItem, people: People, login: string, now: DateTime): RichTextElement[] {
  const { record } = item;
  const author = sameLogin(login)(record.author) ? [] : [person(record.author, people)];
  return row(item, now, author);
}

/** "Kiln - #12 Title · waiting on @reviewer · 3h"; nobody's named while it's on you. */
function mineRow(item: QueueItem, people: People, login: string, now: DateTime): RichTextElement[] {
  const others = item.record.owners.filter((owner) => !sameLogin(login)(owner));
  const waitingOn =
    others.length === 0
      ? []
      : [
          [
            richText.text("waiting on "),
            ...others.flatMap((owner, i) => [...(i > 0 ? [richText.text(", ")] : []), ...person(owner, people)]),
          ],
        ];
  return row(item, now, waitingOn);
}

function row(item: QueueItem, now: DateTime, middle: RichTextElement[][]): RichTextElement[] {
  const { record } = item;
  const age = formatAge(now.diff(record.stateSince).as("hours"));
  const parts = [
    ...middle,
    [item.overdue ? richText.text(`${OVERDUE_EMOJI} ${age}`, { bold: true }) : richText.text(age)],
  ];
  return [
    richText.link(record.url, `${repoName(record.repo)} - #${record.number}`, { bold: true }),
    richText.text(` ${truncate(record.title, MAX_LISTED_TITLE)}`),
    ...parts.flatMap((part) => [richText.text(" · "), ...part]),
  ];
}

function person(login: string, people: People): RichTextElement[] {
  const slackUser = people.slackUser(login);
  return [slackUser ? richText.user(slackUser) : richText.text(login)];
}

// ---- Helpers ----------------------------------------------------------------------------------

function sameLogin(login: string) {
  const key = normalizeGithubLogin(login);
  return (other: string) => normalizeGithubLogin(other) === key;
}

function longestWaitingFirst(records: readonly PRRecord[]): PRRecord[] {
  return [...records].sort((a, b) => a.stateSince.toMillis() - b.stateSince.toMillis());
}

function groupBy(items: readonly QueueItem[], key: (item: QueueItem) => string): QueueGroup[] {
  const groups = new Map<string, QueueItem[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups].map(([title, grouped]) => ({ title, items: grouped }));
}

function filterGroups(groups: readonly QueueGroup[], overdueOnly: boolean): QueueGroup[] {
  if (!overdueOnly) return [...groups];
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.overdue) }))
    .filter((group) => group.items.length > 0);
}

function countItems(groups: readonly QueueGroup[]): number {
  return groups.reduce((sum, group) => sum + group.items.length, 0);
}

function countByState(items: readonly QueueItem[]): StateCount[] {
  const counts = new Map<PRStatusState, number>();
  for (const { record } of items) counts.set(record.state, (counts.get(record.state) ?? 0) + 1);
  return [...counts].map(([state, count]) => ({ state, count }));
}

/** "Kiln-AI/kiln_server" → "kiln_server". */
function repoName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

/** "Merge conflict" → "merge conflict"; acronyms like "CI failing" stay. */
function lowerFirst(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
