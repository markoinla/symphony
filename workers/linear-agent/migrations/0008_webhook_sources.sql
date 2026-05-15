-- SYM-367 — external webhook source configurations and Sentry trigger filters.

CREATE TABLE webhook_sources (
  id              TEXT    PRIMARY KEY,
  organization_id TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  secret          TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  project_id      TEXT    REFERENCES projects(id) ON DELETE SET NULL,
  config          TEXT,
  last_received_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK (provider IN ('sentry'))
);

CREATE INDEX idx_webhook_sources_org ON webhook_sources(organization_id);
CREATE INDEX idx_webhook_sources_provider ON webhook_sources(provider, enabled);

ALTER TABLE workflow_triggers ADD COLUMN sentry_project_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN level_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN fingerprint_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN environment_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN release_filter TEXT;
