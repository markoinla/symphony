/**
 * Linear webhook signature verification.
 *
 * Linear signs each webhook with HMAC-SHA256 over the raw request body
 * using the per-app `LINEAR_WEBHOOK_SECRET`, lowercase hex, sent in the
 * `linear-signature` header.
 *
 * Note: this is a *different* secret and header from the dispatcher HMAC
 * (`X-Symphony-Signature` / `DISPATCH_HMAC_SECRET`). They share the
 * algorithm but nothing else.
 *
 * Docs: https://linear.app/developers/webhooks#securing-webhooks
 */

export type HmacAlgorithm = "sha1" | "sha256";

export async function verifyLinearSignature(
  secret: string,
  body: string | Uint8Array,
  provided: string | null | undefined,
): Promise<boolean> {
  return verifyHmacSignature(secret, body, provided, "sha256");
}

export async function computeLinearSignature(
  secret: string,
  body: string | Uint8Array,
): Promise<string> {
  return computeHmacSignature(secret, body, "sha256");
}

export async function verifyHmacSignature(
  secret: string,
  body: string | Uint8Array,
  provided: string | null | undefined,
  algorithm: HmacAlgorithm,
): Promise<boolean> {
  if (!provided) return false;
  const expected = await computeHmacSignature(secret, body, algorithm);
  const normalized = normalizeProvidedSignature(provided, algorithm);
  return constantTimeEqual(expected, normalized);
}

export async function computeHmacSignature(
  secret: string,
  body: string | Uint8Array,
  algorithm: HmacAlgorithm,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: algorithm === "sha1" ? "SHA-1" : "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof body === "string" ? enc.encode(body) : body;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data as BufferSource));
  let out = "";
  for (const byte of sig) out += byte.toString(16).padStart(2, "0");
  return out;
}

function normalizeProvidedSignature(provided: string, algorithm: HmacAlgorithm): string {
  const trimmed = provided.trim().toLowerCase();
  const prefix = `${algorithm}=`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const ac = i < a.length ? a.charCodeAt(i) : 0;
    const bc = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ac ^ bc;
  }
  return diff === 0;
}
