/**
 * Symphony GitHub App helpers.
 *
 * The App replaces the single org-wide `GITHUB_TOKEN` PAT that today's
 * Workflow uses for `createPr`/`addLabels`/git push. Each org installs
 * the App on their own GitHub org/user; the install id is stored in
 * `installations.github_app_installation_id`. At /run time we mint a
 * fresh ~1h installation token, pass it to the dispatcher in the
 * credentials block, and the dispatcher uses it for the git push +
 * linear-agent uses it for the PR REST calls.
 *
 * Auth flow per GitHub:
 *   1. JWT signed with the App's private key (RS256), with claims
 *      `{iss: <app_id>, iat, exp}` and `exp <= iat + 10min`.
 *   2. POST `/app/installations/<id>/access_tokens` with that JWT as
 *      Bearer. Response: `{token, expires_at}`. The token is the
 *      installation access token.
 *
 * We cache minted tokens in a module-scope Map keyed by installation
 * id, with TTL = `expires_at - 5min`. Workers isolate scope means
 * different isolates re-mint, which is fine — the issuance ceiling
 * (~5k/hr per App) is plenty.
 */

const GITHUB_API = "https://api.github.com";
const JWT_TTL_SECONDS = 9 * 60; // 9 min (max is 10)
const TOKEN_EXPIRY_SAFETY_SECONDS = 5 * 60;

export interface GitHubAppEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALL_URL?: string;
}

export class GitHubAppError extends Error {
  constructor(
    public readonly stage: "config" | "jwt" | "exchange",
    message: string,
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();

/**
 * Mint (or read from cache) an installation access token for `installationId`.
 * Returns the raw token string usable as `Authorization: Bearer <token>`.
 *
 * @throws GitHubAppError when the App is misconfigured (no id / key)
 *         or when the GitHub token exchange returns non-2xx.
 */
export async function mintInstallationToken(
  env: GitHubAppEnv,
  installationId: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - TOKEN_EXPIRY_SAFETY_SECONDS > now) {
    return cached.token;
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new GitHubAppError(
      "config",
      "github_app_not_configured: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY",
    );
  }

  const jwt = await buildAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "symphony-linear-agent",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GitHubAppError(
      "exchange",
      `installation_token_exchange_failed: ${res.status} ${body.slice(0, 300)}`,
    );
  }

  const json = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = Math.floor(Date.parse(json.expires_at) / 1000);
  tokenCache.set(installationId, { token: json.token, expiresAt });
  return json.token;
}

/**
 * Build a short-lived RS256 JWT signed with the App's PEM private
 * key. WebCrypto's `RSASSA-PKCS1-v1_5` import accepts PKCS#8 PEMs
 * directly — most modern GitHub Apps ship one. If the user uploaded
 * a PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`), we accept that here too via
 * a minimal converter to PKCS#8 (no third-party lib).
 */
async function buildAppJwt(
  appId: string,
  pemPrivateKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 30, // tolerate small clock skew
    exp: now + JWT_TTL_SECONDS,
    iss: appId,
  };

  const enc = new TextEncoder();
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  let key: CryptoKey;
  try {
    key = await importPemPrivateKey(pemPrivateKey);
  } catch (e) {
    throw new GitHubAppError(
      "jwt",
      `private_key_import_failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      enc.encode(signingInput),
    ),
  );
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

async function importPemPrivateKey(pem: string): Promise<CryptoKey> {
  const trimmed = pem.trim();
  // PKCS#8: `-----BEGIN PRIVATE KEY-----`
  if (trimmed.includes("BEGIN PRIVATE KEY")) {
    const der = decodePem(trimmed, "PRIVATE KEY");
    return crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  // PKCS#1: `-----BEGIN RSA PRIVATE KEY-----`. WebCrypto doesn't
  // import PKCS#1 directly; wrap it into a PKCS#8 envelope manually.
  if (trimmed.includes("BEGIN RSA PRIVATE KEY")) {
    const der = decodePem(trimmed, "RSA PRIVATE KEY");
    const pkcs8 = wrapPkcs1InPkcs8(der);
    return crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  throw new Error("unsupported_pem_label");
}

function decodePem(pem: string, label: string): Uint8Array {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const b = pem.indexOf(begin);
  const e = pem.indexOf(end);
  if (b === -1 || e === -1) {
    throw new Error(`pem_label_not_found: ${label}`);
  }
  const b64 = pem.slice(b + begin.length, e).replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Wrap a PKCS#1 RSA private key DER blob in a minimal PKCS#8
 * envelope so WebCrypto's `pkcs8` import accepts it.
 *
 * Layout (ASN.1):
 *   PrivateKeyInfo ::= SEQUENCE {
 *     version              Version,                -- INTEGER 0
 *     privateKeyAlgorithm  AlgorithmIdentifier,    -- rsaEncryption
 *     privateKey           OCTET STRING            -- the PKCS#1 blob
 *   }
 */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  // rsaEncryption OID 1.2.840.113549.1.1.1, NULL params.
  const algId = new Uint8Array([
    0x30, 0x0d, // SEQUENCE (13)
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // OID
    0x05, 0x00, // NULL
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  const octet = derEncodeOctetString(pkcs1);
  const inner = concat(version, algId, octet);
  return derEncodeSequence(inner);
}

function derEncodeOctetString(bytes: Uint8Array): Uint8Array {
  const len = derEncodeLength(bytes.length);
  return concat(new Uint8Array([0x04]), len, bytes);
}

function derEncodeSequence(bytes: Uint8Array): Uint8Array {
  const len = derEncodeLength(bytes.length);
  return concat(new Uint8Array([0x30]), len, bytes);
}

function derEncodeLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const out: number[] = [];
  let v = n;
  while (v > 0) {
    out.unshift(v & 0xff);
    v >>>= 8;
  }
  return new Uint8Array([0x80 | out.length, ...out]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Test hook: drop cached tokens. Used by vitest only. */
export function _resetGitHubAppCacheForTests(): void {
  tokenCache.clear();
}
