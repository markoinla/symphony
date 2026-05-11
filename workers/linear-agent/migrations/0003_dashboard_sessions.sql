-- Dashboard session tokens for cookie-based auth.
-- Each row maps a random session token to a users row.
CREATE TABLE dashboard_sessions (
  token           TEXT PRIMARY KEY,
  linear_user_id  TEXT NOT NULL,
  created_at      TEXT DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL
);

CREATE INDEX idx_dashboard_sessions_user ON dashboard_sessions(linear_user_id);
