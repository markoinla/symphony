-- linear-agent v2 schema — Better Auth + multi-tenant domain tables.
--
-- This wipes the previous schema and replaces it with one keyed on
-- Better Auth's `organizations.id` (the tenant). Auth is handled by
-- better-auth (`better-auth-cloudflare` wrapper) with the organization
-- plugin (teams + invitations enabled).
--
-- Conventions:
--   - All identity tables use `text` ids with `usePlural: true`.
--   - Date columns are `integer` Unix timestamps (seconds) so Drizzle's
--     `integer({ mode: 'timestamp' })` reads them as JS Date.
--   - Boolean columns are `integer` 0/1.
--   - All domain tables FK to `organizations(id)` for tenant scoping.
--
-- This migration is destructive — every table is dropped if it
-- exists. Suitable for the current pre-production database. After
-- applying, re-run any seed/bootstrap steps that populate orgs.

-- ────────────────────────────────────────────────────────────────────
-- Drop everything from the previous schema (and any prior partial run)
-- ────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS github_installs;
DROP TABLE IF EXISTS org_credentials;
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS linear_agent_installs;
DROP TABLE IF EXISTS dashboard_sessions;
DROP TABLE IF EXISTS installations;

DROP TABLE IF EXISTS teamMembers;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS organizations;
DROP TABLE IF EXISTS users;

-- ────────────────────────────────────────────────────────────────────
-- Better Auth core (usePlural: true)
-- Order: organizations → users → teams → sessions (refs all 3)
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE organizations (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  slug        TEXT    NOT NULL UNIQUE,
  logo        TEXT,
  metadata    TEXT,                       -- JSON: linearOrgId, etc.
  createdAt   INTEGER NOT NULL
);

CREATE INDEX idx_organizations_slug ON organizations(slug);

CREATE TABLE users (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  email           TEXT    NOT NULL UNIQUE,
  emailVerified   INTEGER NOT NULL DEFAULT 0, -- boolean 0/1
  image           TEXT,
  createdAt       INTEGER NOT NULL,           -- unix seconds
  updatedAt       INTEGER NOT NULL
);

CREATE INDEX idx_users_email ON users(email);

CREATE TABLE teams (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  organizationId  TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  createdAt       INTEGER NOT NULL,
  -- Better Auth's org plugin INSERTs teams with updatedAt = null on
  -- create (it only fills it on subsequent updates), so the column
  -- must be nullable.
  updatedAt       INTEGER
);

CREATE INDEX idx_teams_org ON teams(organizationId);

CREATE TABLE sessions (
  id                    TEXT    PRIMARY KEY,
  expiresAt             INTEGER NOT NULL,
  token                 TEXT    NOT NULL UNIQUE,
  createdAt             INTEGER NOT NULL,
  updatedAt             INTEGER NOT NULL,
  ipAddress             TEXT,
  userAgent             TEXT,
  userId                TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Organization plugin tracks active context per session so
  -- `auth.api.getSession()` returns `session.activeOrganizationId`.
  activeOrganizationId  TEXT             REFERENCES organizations(id) ON DELETE SET NULL,
  activeTeamId          TEXT             REFERENCES teams(id) ON DELETE SET NULL
);

CREATE INDEX idx_sessions_user ON sessions(userId);
CREATE INDEX idx_sessions_token ON sessions(token);

CREATE TABLE accounts (
  id                      TEXT    PRIMARY KEY,
  accountId               TEXT    NOT NULL, -- provider's user id
  providerId              TEXT    NOT NULL, -- 'credential', 'github', 'linear', ...
  userId                  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accessToken             TEXT,
  refreshToken            TEXT,
  idToken                 TEXT,
  accessTokenExpiresAt    INTEGER,
  refreshTokenExpiresAt   INTEGER,
  scope                   TEXT,
  password                TEXT, -- hashed (scrypt) — only for 'credential' provider
  createdAt               INTEGER NOT NULL,
  updatedAt               INTEGER NOT NULL,
  UNIQUE(providerId, accountId)
);

CREATE INDEX idx_accounts_user ON accounts(userId);

CREATE TABLE verifications (
  id          TEXT    PRIMARY KEY,
  identifier  TEXT    NOT NULL, -- email for email-verify, etc.
  value       TEXT    NOT NULL, -- the token / code
  expiresAt   INTEGER NOT NULL,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL
);

CREATE INDEX idx_verifications_identifier ON verifications(identifier);

-- ────────────────────────────────────────────────────────────────────
-- Better Auth organization plugin (teams enabled)
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE members (
  id              TEXT    PRIMARY KEY,
  organizationId  TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  userId          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT    NOT NULL DEFAULT 'member', -- owner|admin|member
  createdAt       INTEGER NOT NULL,
  UNIQUE(organizationId, userId)
);

CREATE INDEX idx_members_org ON members(organizationId);
CREATE INDEX idx_members_user ON members(userId);

CREATE TABLE invitations (
  id              TEXT    PRIMARY KEY,
  organizationId  TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT    NOT NULL,
  role            TEXT    NOT NULL DEFAULT 'member',
  teamId          TEXT             REFERENCES teams(id) ON DELETE SET NULL,
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|canceled
  expiresAt       INTEGER NOT NULL,
  inviterId       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_invitations_org ON invitations(organizationId);
CREATE INDEX idx_invitations_email ON invitations(email);

CREATE TABLE teamMembers (
  id          TEXT    PRIMARY KEY,
  teamId      TEXT    NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  userId      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt   INTEGER NOT NULL,
  UNIQUE(teamId, userId)
);

CREATE INDEX idx_teamMembers_team ON teamMembers(teamId);
CREATE INDEX idx_teamMembers_user ON teamMembers(userId);

-- ────────────────────────────────────────────────────────────────────
-- Domain tables — keyed by Better Auth `organizations.id`
-- ────────────────────────────────────────────────────────────────────

-- The Linear Agent install (actor=app OAuth token). One row per
-- Linear workspace that has installed our Linear Agent. Linked to a
-- Better Auth organization so domain code can resolve a tenant from
-- an incoming Linear webhook by matching `linear_organization_id`.
CREATE TABLE linear_agent_installs (
  id                          TEXT    PRIMARY KEY,
  organization_id             TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  linear_organization_id      TEXT    NOT NULL UNIQUE,
  access_token                TEXT    NOT NULL,
  refresh_token               TEXT,
  scopes                      TEXT    NOT NULL,
  installed_by_user_id        TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status                      TEXT    NOT NULL DEFAULT 'active', -- active|revoked|expired
  installed_at                INTEGER NOT NULL,
  refreshed_at                INTEGER NOT NULL
);

CREATE INDEX idx_linear_agent_installs_org ON linear_agent_installs(organization_id);
CREATE INDEX idx_linear_agent_installs_linear_org ON linear_agent_installs(linear_organization_id);

-- The Symphony GitHub App installation for a tenant.
CREATE TABLE github_installs (
  id              TEXT    PRIMARY KEY,
  organization_id TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  install_id      INTEGER NOT NULL UNIQUE, -- GitHub installation id
  account_login   TEXT    NOT NULL,
  account_type    TEXT    NOT NULL DEFAULT 'Organization', -- Organization|User
  repo_selection  TEXT    NOT NULL DEFAULT 'all',           -- all|selected
  selected_repos  TEXT,                                     -- JSON array
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_github_installs_org ON github_installs(organization_id);
CREATE INDEX idx_github_installs_login ON github_installs(account_login);

-- Per-Linear-team project config. A Linear "team" here means the
-- Linear platform's team concept (SYM, DEV, etc.) — distinct from a
-- Better Auth `teams` row. We keep both — `linear_team_id` is just a
-- string identifier from Linear's GraphQL API.
CREATE TABLE projects (
  id                      TEXT    PRIMARY KEY,
  organization_id         TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  linear_team_id          TEXT    NOT NULL,
  linear_team_name        TEXT    NOT NULL DEFAULT '',
  repo_url                TEXT    NOT NULL,
  default_branch          TEXT    NOT NULL DEFAULT 'main',
  engine                  TEXT    NOT NULL DEFAULT 'pi',
  model                   TEXT,
  max_turns               INTEGER NOT NULL DEFAULT 10,
  scope                   TEXT,
  system_prompt_override  TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE(organization_id, linear_team_id)
);

CREATE INDEX idx_projects_org ON projects(organization_id);

-- Agent run records. One row per Linear Agent Session executed.
-- Distinct from Better Auth `sessions` (which are user sessions).
CREATE TABLE agent_sessions (
  id                  TEXT    PRIMARY KEY,
  organization_id     TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id          TEXT             REFERENCES projects(id) ON DELETE SET NULL,
  linear_issue_id     TEXT,
  linear_issue_title  TEXT,
  status              TEXT    NOT NULL DEFAULT 'running', -- running|complete|error|cancelled
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  triggered_by        TEXT,                                -- e.g. 'webhook', 'rerun', 'manual'
  team                TEXT,                                -- Linear team key for filtering
  repo                TEXT,
  prompt              TEXT,
  config_snapshot     TEXT,                                -- JSON
  stderr              TEXT,
  dispatcher_logs     TEXT,                                -- JSON array
  messages            TEXT,                                -- JSON array
  error               TEXT
);

CREATE INDEX idx_agent_sessions_org        ON agent_sessions(organization_id);
CREATE INDEX idx_agent_sessions_project    ON agent_sessions(project_id);
CREATE INDEX idx_agent_sessions_status     ON agent_sessions(status);
CREATE INDEX idx_agent_sessions_team       ON agent_sessions(team);
CREATE INDEX idx_agent_sessions_repo       ON agent_sessions(repo);
CREATE INDEX idx_agent_sessions_started_at ON agent_sessions(started_at DESC);

-- Per-org BYO secrets, envelope-encrypted.
CREATE TABLE org_credentials (
  id              TEXT    PRIMARY KEY,
  organization_id TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL,  -- 'anthropic', 'openai', 'cf_workers_ai', ...
  ciphertext      BLOB    NOT NULL,
  dek_ciphertext  BLOB    NOT NULL,
  kek_version     INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(organization_id, kind)
);

CREATE INDEX idx_org_credentials_org ON org_credentials(organization_id);
