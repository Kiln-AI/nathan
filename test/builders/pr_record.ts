import { DateTime } from "luxon";
import { NO_DRAFT_NUDGES, NO_REMINDERS, type PRRecord } from "../../src/features/pr_management/store";

const at = (iso: string) => DateTime.fromISO(iso, { zone: "utc" });

/** A stored record of an open team PR by alice that needs a reviewer, opened 2026-10-01. */
export function aRecord(overrides: Partial<PRRecord> = {}): PRRecord {
  const repo = overrides.repo ?? "Kiln-AI/Kiln";
  const number = overrides.number ?? 101;
  return {
    repo,
    number,
    title: "Add the thing",
    url: `https://github.com/${repo}/pull/${number}`,
    author: "alice",
    category: "team",
    createdAt: at("2026-10-01T15:00:00Z"),
    isDraft: false,
    additions: 10,
    deletions: 2,
    headSha: `sha-${number}`,
    mergeable: "mergeable",
    state: "needs_reviewer",
    owners: ["alice"],
    approvers: [],
    stateSince: at("2026-10-01T15:00:00Z"),
    draftSince: null,
    modifiers: [],
    note: null,
    submittedBy: null,
    card: null,
    cardHash: null,
    reminders: NO_REMINDERS,
    draftNudges: NO_DRAFT_NUDGES,
    refreshedAt: at("2026-10-01T15:00:00Z"),
    version: 1,
    ...overrides,
  };
}
