-- Per-org encrypted secrets storage for BYO API keys.
-- Plaintext storage initially; envelope encryption wraps this
-- when SYM-282 lands (KEK/DEK via WebCrypto AES-GCM).

CREATE TABLE IF NOT EXISTS org_credentials (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id  TEXT NOT NULL,
  kind             TEXT NOT NULL,
  ciphertext       TEXT,
  dek_ciphertext   BLOB,
  kek_version      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_org_credentials_org ON org_credentials(organization_id);
