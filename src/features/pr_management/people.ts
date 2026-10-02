import type { UserDirectory } from "../../core/directory";
import { mention } from "../../slack";

/** How GitHub people appear in Slack messages. */
export interface People {
  /** A Slack mention for a mapped login, else the plain login. */
  label(login: string): string;
  /** The login's own Slack user ID; null when unmapped (no triager fallback). */
  slackUser(login: string): string | null;
  /**
   * The Slack user notified for an owner: the owner when mapped, else the triager (spec §5).
   * Null when the triager is unmapped too, so nobody can be told.
   */
  recipient(login: string): string | null;
  /** Mentions of each owner's recipient, deduped. */
  tags(logins: readonly string[]): string[];
}

export function createPeople(directory: UserDirectory, triager: string): People {
  const recipient = (login: string) => directory.byGithub(login)?.slack ?? directory.byGithub(triager)?.slack ?? null;
  return {
    label: (login) => directory.slackMention(login) ?? login,
    slackUser: (login) => directory.byGithub(login)?.slack ?? null,
    recipient,
    tags: (logins) => {
      const recipients = logins.map(recipient).filter((id): id is string => id !== null);
      return [...new Set(recipients)].map(mention);
    },
  };
}
