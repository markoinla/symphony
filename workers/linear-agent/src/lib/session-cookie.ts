/**
 * HMAC-signed dashboard session cookies.
 *
 * Wire format (cookie value):
 *   <base64url(payload_json)>.<base64url(hmac_sha256(payload_json))>
 *
 * Payload: { uid, oid, exp } — Linear user UUID, org UUID, expiry
 * unix seconds. Verifier rejects expired payloads + payloads whose
 * signature doesn't match.
 *
 * Why not stateful sessions in D1: there's no logout-from-all-devices
 * requirement for v1, the cookie is short-lived (12h default), and
 * the dashboard runs in the same Worker as the issuer — a future
 * revocation needs would either bump `DASHBOARD_COOKIE_SECRET`
 * (mass invalidation) or add a stateful path. Trade-off is fine for v1.
 *
 * Secret: `DASHBOARD_COOKIE_SECRET` Workers Secret. Any 32+ byte
 * random string works; we don't constrain length.
 */

const COOKIE_NAME = "sym_dash_session";
const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12h

export interface SessionEnv {
  DASHBOARD_COOKIE_SECRET?: string;
}

export interface SessionPayload {
  /** D1 `users.id` */
  uid: string;
  /** D1 `installations.organization_id` */
  oid: string;
  /** Unix seconds */
  exp: number;
}

/** Builder for `Set-Cookie` header values. */
export async function buildSessionCookie(
  env: SessionEnv,
  payload: Omit<SessionPayload, "exp"> & { exp?: number },
  options: { secure?: boolean; ttlSeconds?: number } = {},
): Promise<string> {
  if (!env.DASHBOARD_COOKIE_SECRET) {
    throw new Error("dashboard_cookie_secret_unset");
  }
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const exp = payload.exp ?? Math.floor(Date.now() / 1000) + ttl;
  const full: SessionPayload = { uid: payload.uid, oid: payload.oid, exp };
  const value = await encodeSigned(env.DASHBOARD_COOKIE_SECRET, full);

  const flags = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ttl}`,
  ];
  // `secure` defaults to true; tests pass `secure: false` for non-HTTPS request fixtures.
  if (options.secure !== false) flags.push("Secure");
  return flags.join("; ");
}

/** Header value that clears the cookie. */
export function buildClearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Read the cookie from a request and verify its signature + expiry.
 * Returns null on any failure (missing cookie, bad signature, expired
 * payload) — callers redirect to /oauth/user/authorize in that case.
 */
export async function readSessionFromRequest(
  env: SessionEnv,
  request: Request,
): Promise<SessionPayload | null> {
  if (!env.DASHBOARD_COOKIE_SECRET) return null;
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const raw = extractCookie(cookieHeader, COOKIE_NAME);
  if (!raw) return null;
  try {
    const payload = await decodeSigned(env.DASHBOARD_COOKIE_SECRET, raw);
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function extractCookie(header: string, name: string): string | null {
  // `cookie` headers are `a=1; b=2; c=3`. Tolerant of leading/trailing
  // whitespace and equals-signs in the value (we b64url-encode, so
  // the value never contains `=`).
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

async function encodeSigned(secret: string, payload: unknown): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(json));
  const sig = await hmac(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

async function decodeSigned(
  secret: string,
  raw: string,
): Promise<SessionPayload> {
  const dot = raw.indexOf(".");
  if (dot === -1) throw new Error("malformed_cookie");
  const payloadB64 = raw.slice(0, dot);
  const sigB64 = raw.slice(dot + 1);
  const expected = await hmac(secret, payloadB64);
  if (!constantTimeEqual(sigB64, expected)) {
    throw new Error("bad_signature");
  }
  const json = new TextDecoder().decode(base64UrlDecode(payloadB64));
  const parsed = JSON.parse(json) as Partial<SessionPayload>;
  if (
    typeof parsed.uid !== "string" ||
    typeof parsed.oid !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    throw new Error("invalid_payload");
  }
  return parsed as SessionPayload;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
  return base64UrlEncode(sig);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]!);
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
