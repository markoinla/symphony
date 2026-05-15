-- SYM-368 — Generic HMAC webhook source columns + trigger filters.
-- Migration 0008 created webhook_sources for GitHub triggers; this migration
-- layers on the generic-specific fields (enabled flag, last-used tracking) and
-- the generic trigger filter columns.

ALTER TABLE webhook_sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE webhook_sources ADD COLUMN last_used_at INTEGER;

ALTER TABLE workflow_triggers ADD COLUMN external_id_filter TEXT;
ALTER TABLE workflow_triggers ADD COLUMN payload_match TEXT;
