import type { DateTime } from "luxon";
import { escapeText, link } from "../../slack";
import type { DraftConfig } from "./config";
import type { PRContext } from "./refresh";
import type { DraftNudgeState, PRRecord } from "./store";

// Draft nudges (spec §4.8): drafts have no card, so their owner is DMed once a draft is
// `nudgeAfterDays` old, then every `nudgeEveryDays`. Nathan never closes PRs.

/** How many nudges a draft should have had by `now`: none before `nudgeAfterDays`. */
export function draftNudgesDue(draftSince: DateTime, now: DateTime, config: DraftConfig): number {
  const days = now.diff(draftSince).as("days");
  if (days < config.nudgeAfterDays) return 0;
  return Math.floor((days - config.nudgeAfterDays) / config.nudgeEveryDays) + 1;
}

export function draftNudgeText(input: {
  record: Pick<PRRecord, "repo" | "number" | "title" | "url" | "author">;
  days: number;
  /** False when the DM goes to the triager for a non-team author. */
  toAuthor: boolean;
}): string {
  const { record, days } = input;
  const pr = `${link(record.url, `${record.repo}#${record.number}`)} ${escapeText(record.title)}`;
  const age = `${days} day${days === 1 ? "" : "s"} old`;
  return input.toAuthor
    ? `Your draft ${pr} is ${age} — finish it, or close it if it's dead.`
    : `The draft ${pr} by ${escapeText(record.author)} is ${age} — nudge the author, or close it if it's dead.`;
}

/**
 * DMs the draft's owner when a nudge is due. Spec §4.8 says "the author"; a non-team author isn't on
 * Slack, so the triager stands in, as for every author-side step (§4.2). After
 * downtime only one DM is sent. The count is recorded first; a failed DM puts it back, so the
 * next sweep tries again.
 */
export async function nudgeDraftIfDue(ctx: PRContext, record: PRRecord): Promise<void> {
  const { config, services, store, people } = ctx;
  const { draftSince } = record;
  if (record.state !== "draft" || !draftSince) return;

  const now = services.clock.now();
  const due = draftNudgesDue(draftSince, now, config.drafts);
  const sentFor = record.draftNudges.for;
  const sent = sentFor && sentFor.toMillis() === draftSince.toMillis() ? record.draftNudges.count : 0;
  if (due <= sent) return;

  const owner = record.owners[0];
  const recipient = owner ? people.recipient(owner) : null;
  if (!recipient) return;

  const nudged: DraftNudgeState = { count: due, for: draftSince };
  // A refresh wrote since this record was read; the next sweep looks again.
  if (!(await store.saveDraftNudges(record.repo, record.number, nudged, record.version))) return;

  // A draft's owner is its author exactly when it's a team PR.
  const toAuthor = record.category === "team";
  const text = draftNudgeText({ record, days: Math.floor(now.diff(draftSince).as("days")), toAuthor });
  try {
    await services.slack.sendDirectMessage(recipient, { text });
  } catch (error) {
    await store.saveDraftNudges(record.repo, record.number, record.draftNudges, record.version + 1);
    throw error;
  }
}
