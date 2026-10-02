import { DateTime } from "luxon";
import type { Db, SqlParam } from "../../core/db";
import type { Mergeable } from "../../github";
import type { PRCategory, PRStatusState } from "./status";

/** Nathan's own facts about a PR (architecture §6: D1 is authoritative only for these). */
export interface PRRecord {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  category: PRCategory;
  createdAt: DateTime;
  isDraft: boolean;
  additions: number;
  deletions: number;
  headSha: string;
  mergeable: Mergeable;
  state: PRStatusState;
  owners: string[];
  /** Reviewers whose latest review approves the PR, unless they're requested again. */
  approvers: string[];
  /** When state or owners last changed. */
  stateSince: DateTime;
  /** When the PR was opened or last converted to draft, whichever is later; null when not a draft. */
  draftSince: DateTime | null;
  modifiers: string[];
  note: string | null;
  /** Slack user ID of whoever submitted the Request PR form. */
  submittedBy: string | null;
  card: CardLocation | null;
  cardHash: string | null;
  reminders: ReminderState;
  draftNudges: DraftNudgeState;
  refreshedAt: DateTime;
  version: number;
}

/** Stale reminders sent (spec §4.6). */
export interface ReminderState {
  /** The last reminder sent to each owner, keyed by lowercase login. */
  sent: Record<string, SentReminder>;
  /** The `stateSince` these belong to: a later state starts from no reminders. */
  for: DateTime | null;
  /** "<template group>:<variant>" of the last reminder, so the next picks another. */
  lastVariant: string | null;
}

export interface SentReminder {
  level: number;
  at: DateTime;
}

/** Draft DMs sent (spec §4.8). */
export interface DraftNudgeState {
  count: number;
  /** The `draftSince` the count belongs to: a draft converted again starts over. */
  for: DateTime | null;
}

export const NO_REMINDERS: ReminderState = { sent: {}, for: null, lastVariant: null };
export const NO_DRAFT_NUDGES: DraftNudgeState = { count: 0, for: null };

export interface CardLocation {
  channel: string;
  ts: string;
}

export interface PREvent {
  id: number;
  event: string;
  action: string | null;
  /** GitHub login of whoever caused it. */
  actor: string | null;
  /** The requested reviewer, or the submitted review's state. */
  subject: string | null;
  receivedAt: DateTime;
}

export type NewPREvent = Omit<PREvent, "id">;

/** A daily report that was posted. */
export interface PostedReport {
  /** The scheduled time it was posted for. */
  slot: DateTime;
  /** Open non-draft PRs at the time. */
  openCount: number;
}

interface PRRow {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  category: string;
  created_at: number;
  is_draft: number;
  additions: number;
  deletions: number;
  head_sha: string;
  mergeable: string;
  state: string;
  owners: string;
  approvers: string;
  state_since: number;
  draft_since: number | null;
  modifiers: string;
  note: string | null;
  submitted_by: string | null;
  card_channel: string | null;
  card_ts: string | null;
  card_hash: string | null;
  reminders_sent: string;
  reminded_for: number | null;
  last_reminder_variant: string | null;
  draft_nudges: number;
  draft_nudged_for: number | null;
  refreshed_at: number;
  version: number;
}

interface EventRow {
  id: number;
  event: string;
  action: string | null;
  actor: string | null;
  subject: string | null;
  received_at: number;
}

const FINAL_STATES = "('merged', 'closed')";

/**
 * The columns a refresh writes: everything except the card. The Request PR form's fields are
 * written here too, so they go through the same compare-and-set as the status.
 */
const REFRESHED_COLUMNS = [
  "title",
  "url",
  "author",
  "category",
  "created_at",
  "is_draft",
  "additions",
  "deletions",
  "head_sha",
  "mergeable",
  "state",
  "owners",
  "approvers",
  "state_since",
  "draft_since",
  "modifiers",
  "note",
  "submitted_by",
  "refreshed_at",
] as const;

export type PRStore = ReturnType<typeof createPRStore>;

export function createPRStore(db: Db) {
  const refreshedValues = (record: PRRecord): SqlParam[] => [
    record.title,
    record.url,
    record.author,
    record.category,
    record.createdAt.toMillis(),
    record.isDraft ? 1 : 0,
    record.additions,
    record.deletions,
    record.headSha,
    record.mergeable,
    record.state,
    JSON.stringify(record.owners),
    JSON.stringify(record.approvers),
    record.stateSince.toMillis(),
    record.draftSince?.toMillis() ?? null,
    JSON.stringify(record.modifiers),
    record.note,
    record.submittedBy,
    record.refreshedAt.toMillis(),
  ];

  return {
    async get(repo: string, number: number): Promise<PRRecord | null> {
      const row = await db.first<PRRow>("SELECT * FROM pr_prs WHERE repo = ? AND number = ?", repo, number);
      return row && toRecord(row);
    },

    /** Inserts a first record at version 1. False when another refresh inserted it first. */
    async insert(record: PRRecord): Promise<boolean> {
      const columns = ["repo", "number", ...REFRESHED_COLUMNS, "version"];
      const result = await db.run(
        `INSERT INTO pr_prs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
         ON CONFLICT (repo, number) DO NOTHING`,
        record.repo,
        record.number,
        ...refreshedValues(record),
        1,
      );
      return result.changes === 1;
    },

    /** Writes the refreshed columns if the record is still at `expectedVersion`, bumping the version. */
    async update(record: PRRecord, expectedVersion: number): Promise<boolean> {
      const result = await db.run(
        `UPDATE pr_prs SET ${REFRESHED_COLUMNS.map((c) => `${c} = ?`).join(", ")}, version = version + 1
         WHERE repo = ? AND number = ? AND version = ?`,
        ...refreshedValues(record),
        record.repo,
        record.number,
        expectedVersion,
      );
      return result.changes === 1;
    },

    /** Puts back `previous`'s status, unless another refresh has written since `version`. */
    async restoreStatus(previous: PRRecord, version: number): Promise<void> {
      await db.run(
        `UPDATE pr_prs SET state = ?, owners = ?, state_since = ?, version = version + 1
         WHERE repo = ? AND number = ? AND version = ?`,
        previous.state,
        JSON.stringify(previous.owners),
        previous.stateSince.toMillis(),
        previous.repo,
        previous.number,
        version,
      );
    },

    /** Takes the lease to post a PR's card. False when it has a card or another lease is live. */
    async claimCard(repo: string, number: number, now: DateTime, leaseExpiredBefore: DateTime): Promise<boolean> {
      const result = await db.run(
        `UPDATE pr_prs SET card_claimed_at = ?
         WHERE repo = ? AND number = ? AND card_ts IS NULL AND (card_claimed_at IS NULL OR card_claimed_at < ?)`,
        now.toMillis(),
        repo,
        number,
        leaseExpiredBefore.toMillis(),
      );
      return result.changes === 1;
    },

    async saveCard(repo: string, number: number, card: CardLocation, hash: string): Promise<void> {
      await db.run(
        `UPDATE pr_prs SET card_channel = ?, card_ts = ?, card_hash = ?, card_claimed_at = NULL
         WHERE repo = ? AND number = ?`,
        card.channel,
        card.ts,
        hash,
        repo,
        number,
      );
    },

    async releaseCard(repo: string, number: number): Promise<void> {
      await db.run("UPDATE pr_prs SET card_claimed_at = NULL WHERE repo = ? AND number = ?", repo, number);
    },

    /**
     * Records the reminders sent if the record is still at `expectedVersion`, bumping the version.
     * False when a refresh has written since: the reminder was planned on a status now replaced.
     */
    async saveReminders(repo: string, number: number, state: ReminderState, expectedVersion: number): Promise<boolean> {
      const result = await db.run(
        `UPDATE pr_prs SET reminders_sent = ?, reminded_for = ?, last_reminder_variant = ?, version = version + 1
         WHERE repo = ? AND number = ? AND version = ?`,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(state.sent).map(([login, { level, at }]) => [login, { level, at: at.toMillis() }]),
          ),
        ),
        state.for?.toMillis() ?? null,
        state.lastVariant,
        repo,
        number,
        expectedVersion,
      );
      return result.changes === 1;
    },

    /** Records the draft DMs sent if the record is still at `expectedVersion`, bumping the version. */
    async saveDraftNudges(
      repo: string,
      number: number,
      state: DraftNudgeState,
      expectedVersion: number,
    ): Promise<boolean> {
      const result = await db.run(
        `UPDATE pr_prs SET draft_nudges = ?, draft_nudged_for = ?, version = version + 1
         WHERE repo = ? AND number = ? AND version = ?`,
        state.count,
        state.for?.toMillis() ?? null,
        repo,
        number,
        expectedVersion,
      );
      return result.changes === 1;
    },

    async saveCardHash(repo: string, number: number, hash: string): Promise<void> {
      await db.run("UPDATE pr_prs SET card_hash = ? WHERE repo = ? AND number = ?", hash, repo, number);
    },

    /** Open PRs whose stored head is `sha`: maps fork check runs and commit statuses to PRs. */
    async openNumbersForHead(repo: string, sha: string): Promise<number[]> {
      const rows = await db.all<{ number: number }>(
        `SELECT number FROM pr_prs WHERE repo = ? AND head_sha = ? AND state NOT IN ${FINAL_STATES} ORDER BY number`,
        repo,
        sha,
      );
      return rows.map((row) => row.number);
    },

    async setHeadSha(repo: string, number: number, sha: string): Promise<void> {
      await db.run("UPDATE pr_prs SET head_sha = ? WHERE repo = ? AND number = ?", sha, repo, number);
    },

    /** Records not yet merged or closed in `repos`. */
    async openRecords(repos: readonly string[]): Promise<PRRecord[]> {
      if (repos.length === 0) return [];
      const rows = await db.all<PRRow>(
        `SELECT * FROM pr_prs WHERE state NOT IN ${FINAL_STATES} AND repo IN (${repos.map(() => "?").join(", ")})
         ORDER BY repo, number`,
        ...repos,
      );
      return rows.map(toRecord);
    },

    async recordEvent(repo: string, number: number, event: NewPREvent): Promise<void> {
      await db.run(
        "INSERT INTO pr_events (repo, number, event, action, actor, subject, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        repo,
        number,
        event.event,
        event.action,
        event.actor,
        event.subject,
        event.receivedAt.toMillis(),
      );
    },

    /** Unconsumed events for a PR received at or before `receivedUpTo`, oldest first. */
    async events(repo: string, number: number, receivedUpTo: DateTime): Promise<PREvent[]> {
      const rows = await db.all<EventRow>(
        `SELECT id, event, action, actor, subject, received_at FROM pr_events
         WHERE repo = ? AND number = ? AND received_at <= ? ORDER BY id`,
        repo,
        number,
        receivedUpTo.toMillis(),
      );
      return rows.map((row) => ({
        id: row.id,
        event: row.event,
        action: row.action,
        actor: row.actor,
        subject: row.subject,
        receivedAt: DateTime.fromMillis(row.received_at, { zone: "utc" }),
      }));
    },

    async deleteEvents(repo: string, number: number, ids: readonly number[]): Promise<void> {
      if (ids.length === 0) return;
      await db.run(
        `DELETE FROM pr_events WHERE repo = ? AND number = ? AND id IN (${ids.map(() => "?").join(", ")})`,
        repo,
        number,
        ...ids,
      );
    },

    /** The latest report posted for a slot before `before`. */
    async lastReport(before: DateTime): Promise<PostedReport | null> {
      const row = await db.first<{ slot: number; open_count: number }>(
        "SELECT slot, open_count FROM pr_reports WHERE slot < ? ORDER BY slot DESC LIMIT 1",
        before.toMillis(),
      );
      return row && { slot: DateTime.fromMillis(row.slot, { zone: "utc" }), openCount: row.open_count };
    },

    async saveReport(report: PostedReport, postedAt: DateTime): Promise<void> {
      await db.run(
        `INSERT INTO pr_reports (slot, open_count, posted_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (slot) DO UPDATE SET open_count = excluded.open_count, posted_at = excluded.posted_at`,
        report.slot.toMillis(),
        report.openCount,
        postedAt.toMillis(),
      );
    },

    /** Drops events no refresh consumed (e.g. for PRs in repos no longer tracked). */
    async pruneEvents(receivedBefore: DateTime): Promise<void> {
      await db.run("DELETE FROM pr_events WHERE received_at < ?", receivedBefore.toMillis());
    },
  };
}

function toRecord(row: PRRow): PRRecord {
  const at = (ms: number) => DateTime.fromMillis(ms, { zone: "utc" });
  return {
    repo: row.repo,
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    category: row.category as PRCategory,
    createdAt: at(row.created_at),
    isDraft: row.is_draft === 1,
    additions: row.additions,
    deletions: row.deletions,
    headSha: row.head_sha,
    mergeable: row.mergeable as Mergeable,
    state: row.state as PRStatusState,
    owners: JSON.parse(row.owners) as string[],
    approvers: JSON.parse(row.approvers) as string[],
    stateSince: at(row.state_since),
    draftSince: row.draft_since === null ? null : at(row.draft_since),
    modifiers: JSON.parse(row.modifiers) as string[],
    note: row.note,
    submittedBy: row.submitted_by,
    card: row.card_channel && row.card_ts ? { channel: row.card_channel, ts: row.card_ts } : null,
    cardHash: row.card_hash,
    reminders: {
      sent: Object.fromEntries(
        Object.entries(JSON.parse(row.reminders_sent) as Record<string, { level: number; at: number }>).map(
          ([login, { level, at: ms }]) => [login, { level, at: at(ms) }],
        ),
      ),
      for: row.reminded_for === null ? null : at(row.reminded_for),
      lastVariant: row.last_reminder_variant,
    },
    draftNudges: {
      count: row.draft_nudges,
      for: row.draft_nudged_for === null ? null : at(row.draft_nudged_for),
    },
    refreshedAt: at(row.refreshed_at),
    version: row.version,
  };
}
