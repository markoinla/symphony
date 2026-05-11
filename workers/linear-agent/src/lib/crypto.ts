/**
 * Envelope encryption for per-org credentials (Anthropic/OpenAI/CF
 * Workers AI keys, GitHub PAT fallback, custom MCP bearers).
 *
 * Two-layer scheme:
 *   1. Per-org 256-bit Data Encryption Key (DEK) — generated fresh on
 *      first write for an org. Encrypts the credential plaintext with
 *      AES-GCM. Different orgs cannot decrypt each other's values even
 *      if a row was leaked.
 *   2. Master Key Encryption Key (KEK) — 256-bit, stored as the
 *      Workers Secret `KEK_V<n>`. Encrypts the DEK so the DEK never
 *      lands on D1 in plaintext.
 *
 * Rotation:
 *   When the operator rotates KEK, set `KEK_V<n+1>`, run a one-off
 *   re-wrap pass that decrypts each row's DEK with `KEK_V<n>`, encrypts
 *   it under `KEK_V<n+1>`, updates `kek_version`. The credential
 *   ciphertext stays unchanged — no per-row plaintext exposure during
 *   rotation. `KEK_V<n>` must remain readable until the re-wrap pass
 *   completes.
 *
 * On-disk layout (BLOB columns):
 *   12-byte random IV ‖ AES-GCM ciphertext ‖ 16-byte auth tag
 *   (WebCrypto returns the tag concatenated to the ciphertext; we
 *   keep that shape unchanged on storage.)
 *
 * Tamper resistance: AES-GCM's auth tag is verified on every decrypt.
 * Any single bit flip in the ciphertext, IV, or tag throws on decrypt
 * — there's no "partial decrypt" leak.
 */

const KEK_BITS = 256;
const DEK_BITS = 256;
const IV_BYTES = 12;
const ALG = "AES-GCM" as const;

export interface CredentialBlob {
  ciphertext: Uint8Array;
  dek_ciphertext: Uint8Array;
  kek_version: number;
}

export interface KekEnv {
  /**
   * Workers Secret holding the current master KEK as a 64-char hex
   * string (32 bytes). The version suffix lets us rotate without a
   * downtime window: set KEK_V2, run a re-wrap pass, drop KEK_V1.
   *
   * Today only KEK_V1 is read; rotation flow will read KEK_V<row.kek_version>.
   */
  KEK_V1?: string;
}

/**
 * Encrypt `plaintext` for an org. Caller persists the returned blob
 * to `org_credentials`. The org-scoped DEK is fresh on every call —
 * we don't reuse DEKs across credential rows for the same org. That
 * costs one extra AES-GCM operation on read but means a single
 * exposed DEK only ever decrypts one stored value.
 */
export async function encryptForOrg(
  env: KekEnv,
  plaintext: string,
): Promise<CredentialBlob> {
  const kekVersion = activeKekVersion();
  const kek = await loadKek(env, kekVersion);

  const dekRaw = crypto.getRandomValues(new Uint8Array(DEK_BITS / 8));
  const dek = await crypto.subtle.importKey(
    "raw",
    dekRaw,
    { name: ALG },
    false,
    ["encrypt"],
  );

  const ciphertext = await sealAesGcm(dek, new TextEncoder().encode(plaintext));
  const dek_ciphertext = await sealAesGcm(kek, dekRaw);

  return { ciphertext, dek_ciphertext, kek_version: kekVersion };
}

/**
 * Decrypt a stored blob back to plaintext. Throws on auth-tag
 * mismatch (tampered ciphertext or wrong KEK version).
 */
export async function decryptForOrg(
  env: KekEnv,
  blob: CredentialBlob,
): Promise<string> {
  const kek = await loadKek(env, blob.kek_version);
  const dekRaw = await openAesGcm(kek, blob.dek_ciphertext);
  const dek = await crypto.subtle.importKey(
    "raw",
    dekRaw,
    { name: ALG },
    false,
    ["decrypt"],
  );
  const plaintextBytes = await openAesGcm(dek, blob.ciphertext);
  return new TextDecoder().decode(plaintextBytes);
}

async function sealAesGcm(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALG, iv }, key, plaintext),
  );
  const out = new Uint8Array(iv.length + ctWithTag.length);
  out.set(iv, 0);
  out.set(ctWithTag, iv.length);
  return out;
}

async function openAesGcm(
  key: CryptoKey,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < IV_BYTES + 16) {
    throw new Error("crypto_blob_too_short");
  }
  const iv = blob.slice(0, IV_BYTES);
  const ctWithTag = blob.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: ALG, iv }, key, ctWithTag);
  return new Uint8Array(pt);
}

async function loadKek(env: KekEnv, version: number): Promise<CryptoKey> {
  const hex = readKekHex(env, version);
  if (!hex) {
    throw new Error(`kek_unavailable_v${version}`);
  }
  const raw = hexToBytes(hex);
  if (raw.length !== KEK_BITS / 8) {
    throw new Error(`kek_invalid_length_v${version}`);
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: ALG },
    false,
    ["encrypt", "decrypt"],
  );
}

function readKekHex(env: KekEnv, version: number): string | undefined {
  // Versioned env access — keep this as a switch so TypeScript can
  // narrow on the Env interface and a typo on the secret name fails
  // at type-check time rather than at first encrypt.
  switch (version) {
    case 1:
      return env.KEK_V1;
    default:
      return undefined;
  }
}

/**
 * Active KEK version is hardcoded to the highest-numbered version
 * currently supported by the code. Bump this when adding KEK_V2 etc.
 */
function activeKekVersion(): number {
  return 1;
}

function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.trim();
  if (trimmed.length % 2 !== 0) {
    throw new Error("kek_hex_odd_length");
  }
  const out = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(trimmed.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("kek_hex_invalid_char");
    }
    out[i] = byte;
  }
  return out;
}
