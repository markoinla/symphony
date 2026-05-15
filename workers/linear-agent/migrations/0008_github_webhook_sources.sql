-- SYM-365 — generic webhook sources + GitHub PR trigger fields.

CREATE TABLE webhook_sources (
  id              TEXT    PRIMARY KEY,
  organization_id TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  secret          TEXT    NOT NULL,
  config          TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_webhook_sources_org ON webhook_sources(organization_id, created_at DESC);
CREATE INDEX idx_webhook_sources_kind ON webhook_sources(kind);

ALTER TABLE webhook_events ADD COLUMN source_id TEXT REFERENCES webhook_sources(id) ON DELETE SET NULL;
CREATE INDEX idx_webhook_events_source ON webhook_events(source_id, received_at DESC);

ALTER TABLE workflow_triggers ADD COLUMN repo_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN branch_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN base_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN draft_filter INTEGER;
ALTER TABLE workflow_triggers ADD COLUMN author_filter TEXT;
