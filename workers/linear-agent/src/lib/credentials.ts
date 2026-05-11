/**
 * Envelope encryption for per-org secrets (BYO API keys, MCP creds).
 *
 * Scheme: per-org DEK (AES-GCM-256) encrypts plaintext; master KEK
 * (AES-GCM-256, from Workers Secrets Store) wraps the DEK. Both
 * ciphertext and wrapped-DEK blobs are prefixed with a 12-byte IV.
 */

const IV_BYTES = 12;
const KEK_ALGO = "AES-GCM";
const DEK_ALGO = "AES-GCM";
const DEK_LENGTH = 256;

export const CURRENT_KEK_VERSION = 1;

export interface OrgCredentialRecord {
  id: number;
  org_id: string;
  kind: string;
  ciphertext: ArrayBuffer;
  dek_ciphertext: ArrayBuffer;
  kek_version: number;
  created_at: string;
  updated_at: string;
}

async function importKek(rawBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(rawBase64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: KEK_ALGO }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
}

async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: DEK_ALGO, length: DEK_LENGTH },
    true,
    ["encrypt", "decrypt"],
  ) as Promise<CryptoKey>;
}

function randomIv(): Uint8Array {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  return iv;
}

function prependIv(iv: Uint8Array, ciphertext: ArrayBuffer): Uint8Array {
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return out;
}

function splitIv(blob: ArrayBuffer): { iv: Uint8Array; data: Uint8Array } {
  const arr = new Uint8Array(blob);
  return {
    iv: arr.slice(0, IV_BYTES),
    data: arr.slice(IV_BYTES),
  };
}

async function wrapDek(
  dek: CryptoKey,
  kek: CryptoKey,
): Promise<Uint8Array> {
  const iv = randomIv();
  const wrapped = await crypto.subtle.wrapKey("raw", dek, kek, {
    name: KEK_ALGO,
    iv,
  });
  return prependIv(iv, wrapped);
}

async function unwrapDek(
  blob: ArrayBuffer,
  kek: CryptoKey,
): Promise<CryptoKey> {
  const { iv, data } = splitIv(blob);
  return crypto.subtle.unwrapKey(
    "raw",
    data,
    kek,
    { name: KEK_ALGO, iv },
    { name: DEK_ALGO, length: DEK_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptWithDek(
  plaintext: string,
  dek: CryptoKey,
): Promise<Uint8Array> {
  const iv = randomIv();
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: DEK_ALGO, iv },
    dek,
    encoded,
  );
  return prependIv(iv, ciphertext);
}

async function decryptWithDek(
  blob: ArrayBuffer,
  dek: CryptoKey,
): Promise<string> {
  const { iv, data } = splitIv(blob);
  const plaintext = await crypto.subtle.decrypt(
    { name: DEK_ALGO, iv },
    dek,
    data,
  );
  return new TextDecoder().decode(plaintext);
}

export class CredentialStore {
  constructor(private readonly db: D1Database) {}

  async encryptForOrg(
    orgId: string,
    kind: string,
    plaintext: string,
    kekBase64: string,
    kekVersion: number = CURRENT_KEK_VERSION,
  ): Promise<void> {
    const kek = await importKek(kekBase64);
    const dek = await generateDek();

    const ciphertext = await encryptWithDek(plaintext, dek);
    const dekCiphertext = await wrapDek(dek, kek);

    await this.db
      .prepare(
        `INSERT INTO org_credentials (org_id, kind, ciphertext, dek_ciphertext, kek_version)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, kind) DO UPDATE SET
           ciphertext     = excluded.ciphertext,
           dek_ciphertext = excluded.dek_ciphertext,
           kek_version    = excluded.kek_version,
           updated_at     = datetime('now')`,
      )
      .bind(
        orgId,
        kind,
        ciphertext.buffer as ArrayBuffer,
        dekCiphertext.buffer as ArrayBuffer,
        kekVersion,
      )
      .run();
  }

  async decryptForOrg(
    orgId: string,
    kind: string,
    kekBase64: string,
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT id, org_id, kind, ciphertext, dek_ciphertext, kek_version,
                created_at, updated_at
         FROM org_credentials
         WHERE org_id = ? AND kind = ?`,
      )
      .bind(orgId, kind)
      .first<OrgCredentialRecord>();

    if (!row) return null;

    const kek = await importKek(kekBase64);
    const dek = await unwrapDek(row.dek_ciphertext, kek);
    return decryptWithDek(row.ciphertext, dek);
  }

  async delete(orgId: string, kind: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM org_credentials WHERE org_id = ? AND kind = ?")
      .bind(orgId, kind)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async listKinds(orgId: string): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT kind FROM org_credentials WHERE org_id = ? ORDER BY kind`,
      )
      .bind(orgId)
      .all<{ kind: string }>();
    return result.results.map((r) => r.kind);
  }
}
