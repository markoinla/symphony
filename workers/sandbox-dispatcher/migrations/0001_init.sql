-- Initial schema for the sandbox-dispatcher D1 database.
--
-- `auth_backups` maps a snapshot scope (e.g. "alice" or "alice:proj-42")
-- to the JSON-serialized DirectoryBackup handle returned by
-- Sandbox.createBackup({...}). The handle is what restoreBackup() needs to
-- repopulate /home/node when starting a per-issue sandbox.
--
-- Granularity of the `scope` value (per-user vs per-user-per-project) is
-- decided in Phase 3 when /auth/snapshot lands; the column stores whatever
-- string the bootstrap caller supplies.

CREATE TABLE auth_backups (
  scope        TEXT PRIMARY KEY,
  handle       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  refreshed_at INTEGER
);
