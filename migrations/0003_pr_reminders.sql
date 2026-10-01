-- pr_management: stale reminders and draft nudges. Additive only (architecture §9).

-- When the PR was opened or last converted to draft, whichever is later; null when not a draft.
ALTER TABLE pr_prs ADD COLUMN draft_since INTEGER;

-- The last reminder sent to each owner: JSON { "<lowercase login>": { "level": n, "at": epoch ms } }.
-- It belongs to the state_since in `reminded_for`, so a state or owner change resets it.
ALTER TABLE pr_prs ADD COLUMN reminders_sent TEXT NOT NULL DEFAULT '{}';
ALTER TABLE pr_prs ADD COLUMN reminded_for INTEGER;
-- The template variant used last ("<group>:<variant>"), so the next reminder picks another.
ALTER TABLE pr_prs ADD COLUMN last_reminder_variant TEXT;

-- Draft DMs sent, for the draft_since in `draft_nudged_for`.
ALTER TABLE pr_prs ADD COLUMN draft_nudges INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pr_prs ADD COLUMN draft_nudged_for INTEGER;
