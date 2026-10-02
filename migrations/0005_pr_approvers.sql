-- pr_management: reviewers who approved, shown with a checkmark beside the reviewers still
-- requested. Additive only (architecture §9).

-- JSON array of GitHub logins whose latest review approves the PR and who aren't requested again.
ALTER TABLE pr_prs ADD COLUMN approvers TEXT NOT NULL DEFAULT '[]';
