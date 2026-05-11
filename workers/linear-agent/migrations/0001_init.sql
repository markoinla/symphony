-- Initial schema for the linear-agent D1 database.
--
-- Two tables, both keyed by Linear identifiers so we never have to
-- maintain our own surrogate keys:
--
--   installations   — one row per Linear workspace that OAuth'd the
--                     agent. Holds the `actor=app` access token used to
--                     post Agent Activities. Replaces the single KV
--                     `access_token` key from item 1.
--
--   projects        — per-team configuration (repo URL, default branch,
--                     engine, model, max_turns). Superseded by the
--                     multi-tenant schema in 0002_multi_tenant.sql.
--
-- `*_at` columns are ISO-8601 strings (datetime('now')) for readability
-- in raw `wrangler d1 execute` queries. The dispatcher worker uses unix
-- epoch ints for its rows; we deliberately chose the more legible
-- format here since linear-agent has fewer time-sensitive operations.

CREATE TABLE installations (
  organization_id TEXT PRIMARY KEY,
  access_token    TEXT NOT NULL,
  scopes          TEXT NOT NULL,
  installed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  refreshed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  team_id         TEXT PRIMARY KEY,
  repo_url        TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  engine          TEXT NOT NULL DEFAULT 'pi',
  model           TEXT,
  max_turns       INTEGER NOT NULL DEFAULT 10,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
