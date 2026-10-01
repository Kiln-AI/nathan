import type { UserDirectory } from "../../core/directory";

/** How GitHub people appear in Slack messages. */
export interface People {
  /** A Slack mention for a mapped login, else the plain login. */
  label(login: string): string;
  /**
   * Mentions that notify these owners, deduped. An unmapped owner falls back to the triager
   * (spec §5); when the triager is unmapped too, nobody is tagged for them.
   */
  tags(logins: readonly string[]): string[];
}

export function createPeople(directory: UserDirectory, triager: string): People {
  return {
    label: (login) => directory.slackMention(login) ?? login,
    tags: (logins) => {
      const mentions = logins
        .map((login) => directory.slackMention(login) ?? directory.slackMention(triager))
        .filter((mention): mention is string => mention !== null);
      return [...new Set(mentions)];
    },
  };
}
