import { z } from "zod";
import { slackChannelId } from "../../core/config";
import { isValidTimeZone } from "../../core/time";
import type { PRStatusState } from "./status";

/** `WIP: …`, `[WIP] …`, `(wip) …`, `WIP …`; matched case-insensitively. */
export const DEFAULT_WIP_TITLE_PATTERN = String.raw`^\s*[[(]?wip\b`;
export const DEFAULT_BOT_AUTHORS = ["dependabot[bot]"];

/** States whose owners get stale reminders: open and not a draft (spec §4.6). */
export const REMINDED_STATES = [
  "wip_title",
  "conflict",
  "ci_failing",
  "awaiting_review",
  "changes_requested",
  "approved",
  "needs_rerequest",
  "needs_reviewer",
] as const satisfies readonly PRStatusState[];

/**
 * Reminder lines by escalation level: levels 1, 2, 3, then 4 and up (the last group repeats).
 * Each is mrkdwn, posted after the owner tags and followed by the next step and age.
 */
export const DEFAULT_REMINDER_TEMPLATES: string[][] = [
  [
    "Friendly nudge 👋 this one's waiting on you.",
    "Hey! This PR could use you when you get a moment ☕",
    "Quick reminder: the ball's in your court 🎾",
  ],
  [
    "Second nudge 👀 this PR is still waiting on you.",
    "This PR has been patient. Very patient. Still waiting on you ⏳",
    "Bumping this back to the top of your list 📌",
  ],
  [
    "Third reminder 😬 this PR is starting to gather dust.",
    "This PR has started writing a memoir about waiting for you 📖",
    "Still here. Still waiting. The PR asked me to say it misses you 🥺",
  ],
  [
    "Reminder number I've-lost-count 🚨 please put this PR out of its misery.",
    "Archaeologists have begun excavating this PR 🦴 It's still waiting on you.",
    "I'll keep asking until it's done. I'm a bot; I have nothing but time 🤖",
  ],
];

const positiveHours = z.number().positive();

const remindersSchema = z.strictObject({
  /** Working hours (weekends excluded) a PR may sit in one state before its owners are reminded. */
  thresholdHours: positiveHours.default(24),
  /** Overrides `thresholdHours` for particular states. */
  thresholdHoursByState: z.partialRecord(z.enum(REMINDED_STATES), positiveHours).default({}),
  /** The threshold for PRs requested with the `urgent` modifier (never longer than the state's own). */
  urgentThresholdHours: positiveHours.default(4),
  /** Reminder lines grouped by level; see DEFAULT_REMINDER_TEMPLATES. */
  templates: z
    .array(z.array(z.string().trim().min(1)).min(1, "needs at least one variant"))
    .min(1)
    .default(DEFAULT_REMINDER_TEMPLATES),
});

const draftsSchema = z.strictObject({
  /** A draft's owner is DMed once it is this many days old… */
  nudgeAfterDays: z.number().int().positive().default(14),
  /** …and again every this many days after that. */
  nudgeEveryDays: z.number().int().positive().default(7),
  /** Drafts this many days old are listed in the daily report's Old drafts section. */
  reportAfterDays: z.number().int().positive().default(30),
});

const reportSchema = z.strictObject({
  /** Local time (24h "HH:MM") the daily report is posted on weekdays. */
  at: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h)")
    .default("09:30"),
  /** The report's time zone; also the zone its dates are shown in. Spec §7: team-wide events use ET. */
  timezone: z.string().refine(isValidTimeZone, { message: "not a valid IANA time zone" }).default("America/New_York"),
});

export type ReminderConfig = z.output<typeof remindersSchema>;
export type DraftConfig = z.output<typeof draftsSchema>;
export type ReportConfig = z.output<typeof reportSchema>;

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
    reminders: remindersSchema.prefault({}),
    drafts: draftsSchema.prefault({}),
    report: reportSchema.prefault({}),
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
