-- pr_management: every reviewer with their status, shown in "Your open PRs" as on the card.
-- Additive only (architecture §9).

-- JSON array of {login, status, team?}: pending reviewers (people, then teams), then everyone
-- else's latest review. Dismissed reviews and the author's own are left out.
ALTER TABLE pr_prs ADD COLUMN reviewers TEXT NOT NULL DEFAULT '[]';

-- `approvers` (0005) is unused now: `reviewers` replaces it. It stays so an older Worker that still
-- writes it keeps working; drop it in a later migration once no deployed Worker writes it.
