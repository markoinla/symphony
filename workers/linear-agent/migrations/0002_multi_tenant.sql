-- v1 multi-tenant schema. Replaces the single-tenant 0001_init tables
-- with org-scoped equivalents and adds orgs, users, credentials,
-- sessions, and usage tables.

-- Drop single-tenant tables from 0001_init.
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS installations;

-- One row per Linear workspace that installed the agent.
CREATE TABLE organizations (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  installer_user_id TEXT NOT NULL,
  plan             TEXT NOT NULL DEFAULT 'free',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-org agent install: actor=app OAuth token for posting activities.
CREATE TABLE installations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL REFERENCES organizations(id),
  access_token     TEXT NOT NULL,
  refresh_token    TEXT,
  scopes           TEXT NOT NULL,
  installed_by     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  installed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  refreshed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id)
);

CREATE INDEX idx_installations_org_id ON installations(org_id);

-- Dashboard users with per-user Linear actor=user OAuth tokens.
CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id),
  linear_user_id   TEXT NOT NULL,
  email            TEXT,
  name             TEXT,
  access_token     TEXT,
  refresh_token    TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, linear_user_id)
);

CREATE INDEX idx_users_org_id ON users(org_id);

-- Per-team project config: repo URL, branch, engine/model overrides.
CREATE TABLE projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL REFERENCES organizations(id),
  linear_team_id   TEXT NOT NULL,
  repo_url         TEXT NOT NULL,
  default_branch   TEXT NOT NULL DEFAULT 'main',
  engine           TEXT NOT NULL DEFAULT 'pi',
  model            TEXT,
  max_turns        INTEGER NOT NULL DEFAULT 10,
  scope            TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, linear_team_id)
);

CREATE INDEX idx_projects_org_id ON projects(org_id);

-- Envelope-encrypted per-org secrets (API keys, GH app metadata, MCP creds).
-- Encryption logic is out of scope for this migration (see SYM-268).
CREATE TABLE org_credentials (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL REFERENCES organizations(id),
  kind             TEXT NOT NULL,
  ciphertext       BLOB,
  dek_ciphertext   BLOB,
  kek_version      INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, kind)
);

CREATE INDEX idx_org_credentials_org_id ON org_credentials(org_id);

-- One row per agent session dispatched to the sandbox.
CREATE TABLE sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL REFERENCES organizations(id),
  dispatcher_run_id TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  cost             REAL,
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at      TEXT
);

CREATE INDEX idx_sessions_org_id ON sessions(org_id);

-- Aggregated usage per org per billing period.
CREATE TABLE usage (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL REFERENCES organizations(id),
  period           TEXT NOT NULL,
  turns            INTEGER NOT NULL DEFAULT 0,
  minutes          REAL NOT NULL DEFAULT 0,
  UNIQUE(org_id, period)
);

CREATE INDEX idx_usage_org_id ON usage(org_id);
