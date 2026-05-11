-- Extend the projects table (from 0002_multi_tenant.sql) with columns
-- needed by the dashboard CRUD UI: human-readable team name, optional
-- system prompt override, and a created_at timestamp.

ALTER TABLE projects ADD COLUMN linear_team_name TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN system_prompt_override TEXT;
ALTER TABLE projects ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));
