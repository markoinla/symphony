-- SYM-368 — Generic HMAC webhook sources.

CREATE TABLE webhook_sources (
  id              TEXT    PRIMARY KEY,
  organization_id TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  kind            TEXT    NOT NULL DEFAULT 'generic',
  enabled         INTEGER NOT NULL DEFAULT 1,
  secret          TEXT    NOT NULL,
  config          TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);

CREATE INDEX idx_webhook_sources_org ON webhook_sources(organization_id);
CREATE INDEX idx_webhook_sources_kind ON webhook_sources(kind, enabled);

ALTER TABLE workflow_triggers ADD COLUMN external_id_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN payload_match TEXT;
