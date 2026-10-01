import type { SlackClient } from "../slack";
import type { PlatformConfig } from "./config";
import type { Db } from "./db";
import type { Logger } from "./log";
import { type Clock, isValidTimeZone } from "./time";

export type DirectoryUser = PlatformConfig["users"][number];

/** The team's GitHub ↔ Slack mapping (config `users`), plus each person's time zone. */
export interface UserDirectory {
  /** Every team member, in config order. */
  users(): readonly DirectoryUser[];
  bySlack(slackId: string): DirectoryUser | undefined;
  /** Case-insensitive; a "[bot]" suffix is ignored. */
  byGithub(login: string): DirectoryUser | undefined;
  /** "<@U…>" for a mapped login, else null (unmapped people are never tagged). */
  slackMention(login: string): string | null;
  /**
   * The config override, else the Slack profile zone (cached in D1 for a day), else
   * `defaults.timezone`. A failed Slack lookup falls back to a stale cache or the default.
   */
  timezone(slackId: string): Promise<string>;
}

export const TZ_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface DirectoryDeps {
  users: readonly DirectoryUser[];
  defaultTimezone: string;
  db: Db;
  clock: Clock;
  slack: Pick<SlackClient, "userTimeZone">;
  log: Logger;
}

export function normalizeGithubLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, "");
}

export function createUserDirectory({ users, defaultTimezone, db, clock, slack, log }: DirectoryDeps): UserDirectory {
  const bySlackId = new Map(users.map((user) => [user.slack, user]));
  const byLogin = new Map(users.map((user) => [normalizeGithubLogin(user.github), user]));
  const byGithub = (login: string) => byLogin.get(normalizeGithubLogin(login));

  async function profileTimezone(slackId: string): Promise<string> {
    const now = clock.now().toMillis();
    const cached = await db.first<{ tz: string; fetched_at: number }>(
      "SELECT tz, fetched_at FROM slack_user_tz WHERE slack_id = ?",
      slackId,
    );
    if (cached && now - cached.fetched_at < TZ_CACHE_TTL_MS) return cached.tz;

    let tz: string | null;
    try {
      tz = await slack.userTimeZone(slackId);
    } catch (error) {
      log.warn("Slack time zone lookup failed", { slackId, error });
      return cached?.tz ?? defaultTimezone;
    }
    if (!tz || !isValidTimeZone(tz)) return defaultTimezone;
    await db.run(
      `INSERT INTO slack_user_tz (slack_id, tz, fetched_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (slack_id) DO UPDATE SET tz = excluded.tz, fetched_at = excluded.fetched_at`,
      slackId,
      tz,
      now,
    );
    return tz;
  }

  return {
    users: () => users,
    bySlack: (slackId) => bySlackId.get(slackId),
    byGithub,
    slackMention: (login) => {
      const user = byGithub(login);
      return user ? `<@${user.slack}>` : null;
    },
    timezone: async (slackId) => bySlackId.get(slackId)?.tz ?? profileTimezone(slackId),
  };
}
