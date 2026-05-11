-- Engine baseline snapshots: one pre-built snapshot per engine containing
-- the engine binary + base toolchain (git, gh CLI, jq) but no credentials.
-- Replaces the per-tenant auth_backups model for /run snapshot restore.

CREATE TABLE engine_baselines (
  engine       TEXT PRIMARY KEY,
  handle       TEXT NOT NULL,
  version      TEXT,
  created_at   INTEGER NOT NULL,
  refreshed_at INTEGER
);
