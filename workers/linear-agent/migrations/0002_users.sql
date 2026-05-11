-- Per-user Linear OAuth tokens for dashboard login and Linear MCP
-- bearer at /run time. Each user belongs to exactly one installed org.
--
-- The user flow uses `read,write` scopes (no `actor=app`) so the token
-- acts as the human, not the agent. Token refresh is handled separately.

CREATE TABLE users (
  linear_user_id  TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES installations(organization_id),
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  expires_at      TEXT,
  email           TEXT,
  name            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  refreshed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_organization_id ON users(organization_id);
