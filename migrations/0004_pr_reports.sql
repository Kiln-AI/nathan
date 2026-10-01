-- pr_management: the daily report (spec §4.7). Additive only (architecture §9).

-- One row per report posted. The next report covers the time since `slot` and shows the change
-- in `open_count`.
CREATE TABLE pr_reports (
  -- The scheduled time the report was posted for (epoch ms).
  slot INTEGER PRIMARY KEY,
  -- Open non-draft PRs at the time.
  open_count INTEGER NOT NULL,
  posted_at INTEGER NOT NULL
);
