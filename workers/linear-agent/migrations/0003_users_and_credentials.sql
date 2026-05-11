-- Users (dashboard logins + Linear MCP bearer source) + per-org
-- encrypted secrets (BYO API keys for Anthropic/OpenAI/CF Workers AI
-- and any future custom MCP creds). SYM-268 v1.
--
-- `users`:
--   One row per human who has logged into the dashboard with Linear
--   `actor=user` OAuth. Stores access_token + refresh_token + ISO-8601
--   `expires_at` so the assemble-credentials Workflow step can refresh
--   aggressively before every /run. `linear_user_id` is the source of
--   truth for matching webhook `actor.id` → "best user token" at
--   dispatch time.
--
-- `org_credentials`:
--   Per-org envelope-encrypted secrets. One row per (org, kind) pair:
--     * `ciphertext` — AES-GCM(IV || ct || tag) of the plaintext value,
--       keyed by a per-org 256-bit DEK.
--     * `dek_ciphertext` — AES-GCM(IV || ct || tag) of the DEK,
--       keyed by the master KEK stored in Workers Secrets as KEK_V<n>.
--     * `kek_version` — which KEK version wrapped this DEK, so we can
--       rotate by wrapping the DEK under a new KEK without re-encrypting
--       every row's ciphertext.
--   Decryption happens only in linear-agent. The dispatcher never sees
--   ciphertext or plaintext — linear-agent decrypts and forwards in
--   the /run credentials block.

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES installations(organization_id) ON DELETE CASCADE,
  linear_user_id      TEXT NOT NULL,
  email               TEXT,
  name                TEXT,
  access_token        TEXT NOT NULL,
  refresh_token       TEXT,
  expires_at          TEXT NOT NULL,
  scopes              TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_users_org_linear ON users (organization_id, linear_user_id);
CREATE INDEX idx_users_linear ON users (linear_user_id);

CREATE TABLE org_credentials (
  organization_id   TEXT NOT NULL REFERENCES installations(organization_id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  ciphertext        BLOB NOT NULL,
  dek_ciphertext    BLOB NOT NULL,
  kek_version       INTEGER NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (organization_id, kind)
);
