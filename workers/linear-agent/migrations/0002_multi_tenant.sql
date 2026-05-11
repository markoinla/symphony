-- Multi-tenant expansion of `installations` + `projects` (SYM-268 v1).
--
-- Additive over 0001 — adds optional columns + a non-unique index. No
-- existing rows need backfill for the worker to keep functioning:
--   * `refresh_token`, `installed_by_linear_user_id`, `expires_at`,
--     `organization_name` default NULL.
--   * `status` defaults to 'active'.
--   * `github_app_installation_id` defaults NULL (an org without it
--     can't get a minted GitHub App token; the Workflow falls back to
--     "skip PR push" if missing — same behavior as today with an
--     unset GITHUB_TOKEN).
--   * `projects.organization_id` defaults NULL (existing single-org
--     row is implicitly the lone installed org). Backfill manually
--     via wrangler d1 execute after deploy.
--
-- `team_id` remains the PK on `projects` since Linear team UUIDs are
-- globally unique; `organization_id` is denormalized scope-tagging,
-- not a uniqueness boundary. The composite index makes "all projects
-- for org X" cheap on the dashboard.

ALTER TABLE installations ADD COLUMN refresh_token TEXT;
ALTER TABLE installations ADD COLUMN installed_by_linear_user_id TEXT;
ALTER TABLE installations ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE installations ADD COLUMN github_app_installation_id INTEGER;
ALTER TABLE installations ADD COLUMN expires_at TEXT;
ALTER TABLE installations ADD COLUMN organization_name TEXT;

ALTER TABLE projects ADD COLUMN organization_id TEXT;
ALTER TABLE projects ADD COLUMN scope_override TEXT;
ALTER TABLE projects ADD COLUMN system_prompt_override TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_organization ON projects (organization_id);
