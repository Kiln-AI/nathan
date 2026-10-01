-- pr_management feature tables. Times are epoch milliseconds (UTC).

-- One row per PR Nathan has seen: Nathan's own facts. GitHub stays authoritative for PR state;
-- `state`/`owners` are the last computed status, kept to detect handoffs and time staleness.
CREATE TABLE pr_prs (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT NOT NULL,
  -- team | dependabot | oss
  category TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_draft INTEGER NOT NULL,
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  -- Last known mergeability; GitHub's "unknown" never overwrites a known value.
  mergeable TEXT NOT NULL,
  state TEXT NOT NULL,
  -- JSON array of GitHub logins, sorted.
  owners TEXT NOT NULL,
  -- When state or owners last changed: the staleness clock's start.
  state_since INTEGER NOT NULL,
  -- From the Request PR form: JSON array of modifiers, the note, and the submitter's Slack ID.
  modifiers TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  submitted_by TEXT,
  -- The live card in the PR channel, the hash of its last rendered content, and a short lease
  -- that stops two refreshes posting the same card.
  card_channel TEXT,
  card_ts TEXT,
  card_hash TEXT,
  card_claimed_at INTEGER,
  refreshed_at INTEGER NOT NULL,
  -- Compare-and-set between concurrent refreshes.
  version INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX pr_prs_head ON pr_prs (repo, head_sha);
CREATE INDEX pr_prs_state ON pr_prs (state);

-- Webhook events not yet consumed by a refresh: who did what, for handoff messages.
CREATE TABLE pr_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  event TEXT NOT NULL,
  action TEXT,
  actor TEXT,
  -- The requested reviewer, or the submitted review's state.
  subject TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX pr_events_pr ON pr_events (repo, number, id);
CREATE INDEX pr_events_received_at ON pr_events (received_at);
