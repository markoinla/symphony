-- SYM-367 — Sentry webhook source columns + Sentry trigger filters.
-- Layers on top of the unified webhook_sources table (created by 0008 for
-- GitHub, extended by 0009 with enabled/last_used_at for Generic).

ALTER TABLE webhook_sources ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE workflow_triggers ADD COLUMN sentry_project_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN level_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN fingerprint_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN environment_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN release_filter TEXT;
