import { DateTime } from "luxon";
import { normalizeGithubLogin } from "../../core/directory";
import { latestFireAtOrBefore, type Schedule } from "../../core/scheduler";
import { formatAge, weekendExcludedHours } from "../../core/time";
import type { PRHistory } from "../../github";
import {
  actions,
  button,
  chunkBlocks,
  context,
  divider,
  escapeText,
  header,
  MAX_MESSAGE_BLOCKS,
  type MessageBlock,
  sectionsFromLines,
} from "../../slack";
import { ownersText, prListTitle } from "./card";
import type { ReportConfig } from "./config";
import { mean, median, peopleStats, prKey, type TrendStats, trendStats } from "./metrics";
import type { PRContext } from "./refresh";
import { thresholdHours } from "./reminders";
import { OPEN_REQUEST_PR_ACTION } from "./request_form";
import { STATE_INFO } from "./status";
import type { PRRecord } from "./store";
import { sweep } from "./sweep";

// The daily report (spec §4.7): PR health posted to the PR channel each weekday morning, with
// weekly Trends and People on Mondays. People are named by GitHub login, not tagged: reminders
// already ping owners, and a daily summary shouldn't.

/** How far back the weekly sections look: this week and the one before. */
export const TREND_DAYS = 14;
export const ALL_CLEAR_TEXT = "*All clear* 🎉 No open PRs.";
export const CONTINUED_TEXT = "_Continued in the thread_ 🧵";

const SOURCE = "pr_management.daily_report";

export interface ReportInput {
  /** The scheduled time the report is for. */
  slot: DateTime;
  now: DateTime;
  /** The start of "since the last report". */
  since: DateTime;
  /** The zone dates are shown in. */
  timezone: string;
  /** Adds the Monday sections, Trends and People. */
  weekly: boolean;
  /** Open non-draft PRs in the last report, or null when there wasn't one. */
  previousOpenCount: number | null;
  /** Open (not merged or closed) records, drafts included. */
  records: readonly PRRecord[];
  /** Owners past their reminder threshold, by `prKey`. */
  overdue: ReadonlyMap<string, readonly string[]>;
  /** Tracked PRs updated since `since` (on Mondays, since at least TREND_DAYS ago). */
  history: readonly PRHistory[];
  /** Team members' GitHub logins. */
  team: readonly string[];
  triager: string;
  /** Drafts at least this many days old are listed. */
  oldDraftDays: number;
}

export interface ReportMessage {
  text: string;
  blocks: MessageBlock[];
}

/** The report's schedule: weekdays at the configured local time. */
export function reportSchedule(config: ReportConfig): Schedule {
  return { at: config.at, tz: config.timezone, days: "weekdays" };
}

/**
 * The report as Slack messages: the first goes to the channel, any others in its thread. Lines are
 * packed into sections of at most 3000 characters, and blocks into messages of at most 50.
 */
export function buildReport(input: ReportInput): [ReportMessage, ...ReportMessage[]] {
  const open = openPRs(input.records);
  const date = input.slot.setZone(input.timezone).toFormat("ccc LLL d");
  const attention = needsAttention(input, open);

  const lead: MessageBlock[] = [
    header(`PR report · ${date}`),
    ...sectionsFromLines(headline(input, open)),
    actions([button({ text: "Request PR", actionId: OPEN_REQUEST_PR_ACTION, style: "primary" })]),
  ];
  const sections = [
    attention.lines,
    ossContributors(input, open),
    dependabot(input, open),
    oldDrafts(input),
    ...(input.weekly ? [trends(input), people(input)] : []),
  ].filter((lines) => lines.length > 0);
  const blocks = [...lead, ...sections.flatMap((lines) => [divider(), ...sectionsFromLines(lines)])];

  const needing =
    attention.count > 0 ? `, ${attention.count} ${attention.count === 1 ? "needs" : "need"} attention` : "";
  const text = `PR report for ${date}: ${count(open.length, "open PR")}${needing}`;
  if (blocks.length <= MAX_MESSAGE_BLOCKS) return [{ text, blocks }];

  const firstRoom = MAX_MESSAGE_BLOCKS - 1;
  const rest = chunkBlocks(blocks.slice(firstRoom)).map((part, index) => ({
    text: `${text} (part ${index + 2})`,
    blocks: part,
  }));
  return [{ text, blocks: [...blocks.slice(0, firstRoom), context(CONTINUED_TEXT)] }, ...rest];
}

export interface GeneratedReport {
  messages: [ReportMessage, ...ReportMessage[]];
  openCount: number;
}

/**
 * Sweeps, gathers inputs and builds the report. Does not post or record the report, so callers
 * control where it goes and whether it counts as a scheduled report.
 */
export async function generateReport(ctx: PRContext, slot: DateTime): Promise<GeneratedReport> {
  const { config, services, store } = ctx;
  try {
    await sweep(ctx);
  } catch (error) {
    await services.reportError(error, { source: SOURCE, phase: "sweep" });
  }

  const now = services.clock.now();
  const schedule = reportSchedule(config.report);
  const weekly = slot.setZone(config.report.timezone).weekday === 1;
  const last = await store.lastReport(slot);
  const since = last?.slot ?? latestFireAtOrBefore(schedule, slot.minus({ minutes: 1 }));
  const historySince = weekly ? DateTime.min(since, now.minus({ days: TREND_DAYS })) : since;
  const [records, history] = await Promise.all([
    store.openRecords(config.repos),
    services.github.reader.recentPullRequests(config.repos, historySince),
  ]);

  const messages = buildReport({
    slot,
    now,
    since,
    timezone: config.report.timezone,
    weekly,
    previousOpenCount: last?.openCount ?? null,
    records,
    overdue: await overdueOwners(ctx, records, now),
    history,
    team: services.directory.users().map((user) => user.github),
    triager: config.triager,
    oldDraftDays: config.drafts.reportAfterDays,
  });

  return { messages, openCount: openPRs(records).length };
}

/**
 * The `daily_report` task. Runs the sweep first so the report reflects GitHub now; if the sweep
 * fails, it is reported and the report goes out from the stored records.
 */
export async function postDailyReport(ctx: PRContext, slot: DateTime): Promise<void> {
  const {
    messages: [first, ...rest],
    openCount,
  } = await generateReport(ctx, slot);
  const { config, services, store } = ctx;
  const now = services.clock.now();
  const posted = await services.slack.postMessage({ channel: config.channel, ...first });
  await store.saveReport({ slot, openCount }, now);
  for (const part of rest) {
    await services.slack.postMessage({ channel: posted.channel, thread_ts: posted.ts, ...part });
  }
}

/**
 * Each open PR's owners who are past its reminder threshold, counting working hours in the state in
 * the time zone of whoever is told about them (the report's zone when nobody can be).
 */
async function overdueOwners(ctx: PRContext, records: readonly PRRecord[], now: DateTime) {
  const { config, people, services } = ctx;
  const overdue = new Map<string, string[]>();
  for (const record of openPRs(records)) {
    const threshold = thresholdHours(record.state, record.modifiers, config.reminders);
    const owners: string[] = [];
    for (const login of record.owners) {
      const recipient = people.recipient(login);
      const tz = recipient ? await services.directory.timezone(recipient) : config.report.timezone;
      if (weekendExcludedHours(record.stateSince, now, tz) >= threshold) owners.push(login);
    }
    if (owners.length > 0) overdue.set(prKey(record), owners);
  }
  return overdue;
}

function openPRs(records: readonly PRRecord[]): PRRecord[] {
  return records.filter((record) => record.state !== "draft");
}

function headline(input: ReportInput, open: readonly PRRecord[]): string[] {
  const { history, since, now } = input;
  const opened = history.filter((pr) => pr.createdAt >= since).length;
  const merged = history.filter((pr) => pr.mergedAt !== null && pr.mergedAt >= since).length;
  const flow = `*${opened}* opened · *${merged}* merged since ${since.setZone(input.timezone).toFormat("ccc LLL d")}`;
  if (open.length === 0) return [ALL_CLEAR_TEXT, flow];

  const ages = open.map((record) => hoursSince(record.createdAt, now));
  return [
    `*${open.length}* ${plural(open.length, "open PR")}${change(open.length, input.previousOpenCount)}`,
    flow,
    `Age: median *${hours(median(ages))}* · mean *${hours(mean(ages))}*`,
  ];
}

function change(current: number, previous: number | null): string {
  if (previous === null) return "";
  const delta = current - previous;
  if (delta === 0) return " (no change since the last report)";
  return ` (${delta > 0 ? `+${delta}` : `−${-delta}`} since the last report)`;
}

/**
 * Stale PRs grouped by overdue owner, groups and PRs oldest first. Dependabot PRs are left to their
 * own compact section, where the triager sees them all anyway.
 */
function needsAttention(input: ReportInput, open: readonly PRRecord[]): { lines: string[]; count: number } {
  const groups = new Map<string, { owner: string; records: PRRecord[] }>();
  let stale = 0;
  for (const record of oldestFirst(open)) {
    const owners = record.category === "dependabot" ? undefined : input.overdue.get(prKey(record));
    if (!owners) continue;
    stale += 1;
    for (const owner of owners) {
      const key = normalizeGithubLogin(owner);
      const group = groups.get(key) ?? { owner, records: [] };
      group.records.push(record);
      groups.set(key, group);
    }
  }
  if (stale === 0) return { lines: [], count: 0 };
  // Groups were created in order of their oldest PR.
  const lines = [...groups.values()].flatMap(({ owner, records }) => [
    `*${escapeText(owner)}*`,
    ...records.map((record) => prLine(record, input.now, [nextStep(record)])),
  ]);
  return { lines: [`*Needs attention* (${stale})`, ...lines], count: stale };
}

function ossContributors(input: ReportInput, open: readonly PRRecord[]): string[] {
  const oss = oldestFirst(open.filter((record) => record.category === "oss"));
  if (oss.length === 0) return [];
  return [
    `*OSS contributors* (${oss.length}, triager ${escapeText(input.triager)})`,
    ...oss.map((record) => prLine(record, input.now, [nextStep(record), ...ownersOf(record)])),
  ];
}

function dependabot(input: ReportInput, open: readonly PRRecord[]): string[] {
  const bots = oldestFirst(open.filter((record) => record.category === "dependabot"));
  if (bots.length === 0) return [];
  return [`*Dependabot* (${bots.length})`, ...bots.map((record) => prLine(record, input.now, ownersOf(record)))];
}

function oldDrafts(input: ReportInput): string[] {
  const cutoff = input.now.minus({ days: input.oldDraftDays });
  const drafts = input.records
    .map((record) => ({ record, since: record.draftSince ?? record.createdAt }))
    .filter(({ record, since }) => record.state === "draft" && since <= cutoff)
    .sort((a, b) => a.since.toMillis() - b.since.toMillis());
  if (drafts.length === 0) return [];
  return [
    `*Old drafts* (${drafts.length}, over ${input.oldDraftDays} days)`,
    ...drafts.map(
      ({ record, since }) =>
        `• ${prListTitle(record)} · by ${escapeText(record.author)} · ${formatAge(hoursSince(since, input.now))}`,
    ),
  ];
}

function trends(input: ReportInput): string[] {
  const team = new Set(input.team.map(normalizeGithubLogin));
  const isTeam = (login: string) => team.has(normalizeGithubLogin(login));
  const weekEnding = (end: DateTime) =>
    trendStats({ start: end.minus({ days: 7 }), end }, input.history, input.records, isTeam);
  const thisWeek = weekEnding(input.now);
  const lastWeek = weekEnding(input.now.minus({ days: 7 }));
  if (isEmpty(thisWeek) && isEmpty(lastWeek)) return [];

  const row = (label: string, now: string, before: string) => `• ${label}: *${now}* (the week before: ${before})`;
  return [
    "*Trends* (team PRs, last 7 days)",
    row("Median time to first review", hours(thisWeek.firstReviewHours), hours(lastWeek.firstReviewHours)),
    row("Median time to merge", hours(thisWeek.mergeHours), hours(lastWeek.mergeHours)),
    row("PRs merged", String(thisWeek.merged), String(lastWeek.merged)),
    row("Median open PR age", hours(thisWeek.openAgeHours), hours(lastWeek.openAgeHours)),
  ];
}

function isEmpty(stats: TrendStats): boolean {
  return stats.merged === 0 && stats.firstReviewHours === null && stats.openAgeHours === null;
}

function people(input: ReportInput): string[] {
  const stats = peopleStats(input.team, input.records, input.history, input.now.minus({ days: 7 }));
  if (stats.length === 0) return [];
  return [
    "*People* (last 7 days)",
    ...stats.map(
      (s) =>
        `• ${escapeText(s.login)}: ${s.open} open · ${count(s.reviewsWaiting, "review")} waiting on them · ` +
        `${s.merged} merged · ${count(s.reviewed, "PR")} reviewed`,
    ),
  ];
}

function prLine(record: PRRecord, now: DateTime, details: readonly string[]): string {
  const info = STATE_INFO[record.state];
  return [
    `• ${prListTitle(record)}`,
    `${info.emoji} ${info.label}`,
    ...details,
    formatAge(hoursSince(record.createdAt, now)),
  ].join(" · ");
}

function nextStep(record: PRRecord): string {
  return `Next: ${STATE_INFO[record.state].nextStep}`;
}

function ownersOf(record: PRRecord): string[] {
  const owners = ownersText(record.owners.map((login) => escapeText(login)));
  return owners ? [owners] : [];
}

function oldestFirst(records: readonly PRRecord[]): PRRecord[] {
  return [...records].sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

function hoursSince(time: DateTime, now: DateTime): number {
  return now.diff(time).as("hours");
}

function hours(value: number | null): string {
  return value === null ? "—" : formatAge(value);
}

function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}

function count(n: number, noun: string): string {
  return `${n} ${plural(n, noun)}`;
}
