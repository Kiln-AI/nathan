import type { DateTime } from "luxon";
import { formatAge, weekendExcludedHours } from "../../core/time";
import type { PRData } from "../../github";
import { mention } from "../../slack";
import { isReminded, type ReminderConfig } from "./config";
import { prKey } from "./metrics";
import { ensureCard, type PRContext } from "./refresh";
import { type PRStatusState, STATE_INFO } from "./status";
import type { PRRecord, ReminderState, SentReminder } from "./store";

// Stale reminders (spec §4.6): once a PR has sat in one state for a threshold of working hours,
// its owners are reminded in the card thread, then again one level higher after each further
// threshold.

/** One owner's wait, in the time zone of whoever is told about it. */
export interface OwnerWait {
  login: string;
  /** Slack user ID tagged for this owner (the owner, or the triager for an unmapped one). */
  recipient: string;
  /**
   * Hours since this owner's last reminder in the current state (or since the state began, before
   * the first), weekends excluded in the recipient's time zone.
   */
  workingHours: number;
}

export interface ReminderPlan {
  /** Slack user IDs to tag, deduped. */
  recipients: string[];
  /** The escalation level of the reply: the highest among the owners tagged. */
  level: number;
  /** What to record once it's sent, by lowercase login. */
  sent: Record<string, SentReminder>;
}

export interface PickedTemplate {
  text: string;
  /** "<group>:<variant>", recorded so the next reminder avoids it. */
  variant: string;
}

const URGENT = "urgent";

/** The state's threshold (default or per-state), shortened for `urgent` PRs, never lengthened. */
export function thresholdHours(state: PRStatusState, modifiers: readonly string[], config: ReminderConfig): number {
  const byState = config.thresholdHoursByState as Partial<Record<PRStatusState, number>>;
  const threshold = byState[state] ?? config.thresholdHours;
  return modifiers.includes(URGENT) ? Math.min(threshold, config.urgentThresholdHours) : threshold;
}

/** The reminders sent in the record's current state; none once the state or owners have changed. */
export function currentReminders(record: Pick<PRRecord, "reminders" | "stateSince">): Record<string, SentReminder> {
  const sentFor = record.reminders.for;
  return sentFor && sentFor.toMillis() === record.stateSince.toMillis() ? record.reminders.sent : {};
}

/**
 * An owner is due once a full threshold of working hours has passed since their last reminder
 * (or since the state began), and each reminder is one level above their last, so the first is
 * always level 1 however long the PR has waited (e.g. after `urgent` shortens the threshold).
 * After downtime an owner gets one reminder per sweep at most. One reply tags every due owner.
 * Null when nobody is due.
 */
export function planReminder(
  waits: readonly OwnerWait[],
  sent: Readonly<Record<string, SentReminder>>,
  threshold: number,
  now: DateTime,
): ReminderPlan | null {
  const next = { ...sent };
  const recipients = new Set<string>();
  let level = 0;
  for (const wait of waits) {
    if (wait.workingHours < threshold) continue;
    const key = wait.login.toLowerCase();
    const due = (sent[key]?.level ?? 0) + 1;
    next[key] = { level: due, at: now };
    recipients.add(wait.recipient);
    level = Math.max(level, due);
  }
  return level === 0 ? null : { recipients: [...recipients], level, sent: next };
}

/**
 * A random variant from the level's group (the last group serves every higher level), avoiding
 * the variant this PR got last time when the group has another.
 */
export function pickTemplate(
  templates: readonly (readonly string[])[],
  level: number,
  lastVariant: string | null,
  random: () => number,
): PickedTemplate {
  const group = Math.min(level, templates.length) - 1;
  // Config validation guarantees every group has a variant.
  const variants = templates[group] ?? [];
  const choices = variants.map((_, index) => index).filter((index) => `${group}:${index}` !== lastVariant);
  const index = variants.length > 1 ? (choices[Math.floor(random() * choices.length)] ?? 0) : 0;
  return { text: variants[index] ?? "", variant: `${group}:${index}` };
}

export function reminderText(input: {
  recipients: readonly string[];
  template: string;
  nextStep: string;
  waitingHours: number;
  ageHours: number;
}): string {
  const tags = input.recipients.map(mention).join(" ");
  const facts = `*Next step:* ${input.nextStep} · waiting ${formatAge(input.waitingHours)} · opened ${formatAge(input.ageHours)} ago`;
  return `${tags} — ${input.template}\n${facts}`;
}

/**
 * Sends the PR's reminder if one is due: posts the card if it has none, records the reminders,
 * then replies in the card thread. A failed reply puts the old record back, so the next sweep
 * sends it. Drafts, PRs in a merge queue, and merged or closed PRs never get reminders.
 */
export async function remindIfDue(ctx: PRContext, record: PRRecord, pr: PRData, random: () => number): Promise<void> {
  const { config, services, store } = ctx;
  if (!isReminded(record.state)) return;
  const nextStep = STATE_INFO[record.state].nextStep;

  const now = services.clock.now();
  const threshold = thresholdHours(record.state, record.modifiers, config.reminders);
  const sent = currentReminders(record);
  const plan = planReminder(await ownerWaits(ctx, record, sent, now), sent, threshold, now);
  if (!plan) return;

  const card = await ensureCard(ctx, record, pr);
  // Another refresh is posting the card right now; the next sweep reminds in it.
  if (!card) return;

  const template = pickTemplate(config.reminders.templates, plan.level, record.reminders.lastVariant, random);
  const reminders: ReminderState = { sent: plan.sent, for: record.stateSince, lastVariant: template.variant };
  // A refresh wrote since this record was read: the plan may be for a replaced status.
  if (!(await store.saveReminders(record.repo, record.number, reminders, record.version))) return;

  const text = reminderText({
    recipients: plan.recipients,
    template: template.text,
    nextStep,
    waitingHours: now.diff(record.stateSince).as("hours"),
    ageHours: now.diff(record.createdAt).as("hours"),
  });
  try {
    await services.slack.postMessage({ channel: card.channel, thread_ts: card.ts, text });
  } catch (error) {
    await store.saveReminders(record.repo, record.number, record.reminders, record.version + 1);
    throw error;
  }
}

/** Owners nobody can be told about (unmapped, with an unmapped triager) are left out. */
async function ownerWaits(
  ctx: PRContext,
  record: PRRecord,
  sent: Readonly<Record<string, SentReminder>>,
  now: DateTime,
): Promise<OwnerWait[]> {
  const waits: OwnerWait[] = [];
  for (const login of record.owners) {
    const recipient = ctx.people.recipient(login);
    if (!recipient) continue;
    const tz = await ctx.services.directory.timezone(recipient);
    const since = sent[login.toLowerCase()]?.at ?? record.stateSince;
    waits.push({ login, recipient, workingHours: weekendExcludedHours(since, now, tz) });
  }
  return waits;
}

/**
 * Each PR's owners who are past its reminder threshold, by `prKey`: working hours in the current
 * state, weekends excluded, in the time zone of whoever is told about them (the report's zone
 * when nobody can be). PRs that never get reminders (drafts, merge queue) have no overdue owners.
 * The daily report's Needs attention section and the personal queue's Overdue both use this rule;
 * Needs attention additionally leaves Dependabot PRs to their own section, while the triager's
 * queue counts them.
 */
export async function overdueOwners(
  ctx: PRContext,
  records: readonly PRRecord[],
  now: DateTime,
): Promise<Map<string, string[]>> {
  const { config, people, services } = ctx;
  const overdue = new Map<string, string[]>();
  for (const record of records) {
    if (!isReminded(record.state)) continue;
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
