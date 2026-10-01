import { z } from "zod";
import { slackChannelId } from "../../core/config";

/** `WIP: …`, `[WIP] …`, `(wip) …`, `WIP …`; matched case-insensitively. */
export const DEFAULT_WIP_TITLE_PATTERN = String.raw`^\s*[[(]?wip\b`;
export const DEFAULT_BOT_AUTHORS = ["dependabot[bot]"];

export const prConfigSchema = z
  .strictObject({
    /** "owner/name" of every tracked repo. */
    // The same shape `parseRepo` (src/github/repo.ts) accepts, so a repo the reader would reject fails here.
    repos: z.array(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "must be owner/name")).min(1),
    /** The channel holding the PR cards (by ID). */
    channel: slackChannelId,
    /** GitHub login that owns author-side steps of Dependabot and OSS PRs. */
    triager: z.string().min(1),
    /** PR authors treated as Dependabot PRs. */
    botAuthors: z.array(z.string().min(1)).default(DEFAULT_BOT_AUTHORS),
    /** A regular expression (case-insensitive) for titles that mark a PR as work in progress. */
    wipTitlePattern: z
      .string()
      .default(DEFAULT_WIP_TITLE_PATTERN)
      .refine(isValidRegex, { message: "not a valid regular expression" }),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.repos.forEach((repo, index) => {
      const key = repo.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["repos", index], message: `duplicate repo "${repo}"` });
      seen.add(key);
    });
  });

export type PRConfig = z.output<typeof prConfigSchema>;

declare module "../../core/config" {
  interface FeatureSectionInputs {
    pr_management: z.input<typeof prConfigSchema>;
  }
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}
