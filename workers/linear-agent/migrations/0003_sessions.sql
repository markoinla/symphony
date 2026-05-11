-- Sessions table for tracking agent session runs.
--
-- Stores metadata + debug payload for each dispatch so the dashboard
-- can list, filter, and inspect sessions without querying the
-- Cloudflare Workflow API.

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  linear_issue_id   TEXT,
  linear_issue_title TEXT,
  status            TEXT NOT NULL DEFAULT 'running',
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT,
  triggered_by      TEXT,
  team              TEXT,
  repo              TEXT,
  prompt            TEXT,
  config_snapshot   TEXT,
  stderr            TEXT,
  dispatcher_logs   TEXT,
  messages          TEXT,
  error             TEXT
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_team ON sessions(team);
CREATE INDEX idx_sessions_repo ON sessions(repo);
CREATE INDEX idx_sessions_started_at ON sessions(started_at DESC);
