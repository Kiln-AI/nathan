-- Core platform tables. Times are epoch milliseconds (UTC).

-- Scheduler claims: the fire time each scheduled task last ran for.
CREATE TABLE job_runs (
  name TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL
);

-- Trailing-edge debounce state. `key` is "<job name>:<caller key>".
CREATE TABLE debounce (
  key TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  version INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

-- GitHub delivery dedupe (X-GitHub-Delivery). Pruned after 7 days.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX webhook_deliveries_received_at ON webhook_deliveries (received_at);

-- Admin alert dedupe: one post per error key per hour.
CREATE TABLE admin_alerts (
  key TEXT PRIMARY KEY,
  last_posted_at INTEGER NOT NULL
);

-- Directory cache of Slack profile time zones.
CREATE TABLE slack_user_tz (
  slack_id TEXT PRIMARY KEY,
  tz TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
