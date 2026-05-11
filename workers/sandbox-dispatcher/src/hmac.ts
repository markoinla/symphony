import type { MiddlewareHandler } from "hono";

/**
 * HMAC verification middleware.
 *
 * Symphony signs every dispatcher request with HMAC-SHA256 over the raw
 * request body, using the shared `DISPATCH_HMAC_SECRET` as the key. The
 * signature is sent as a hex string in the `X-Symphony-Signature` header.
 *
 * Empty bodies are signed too (the empty string hashes to a fixed value),
 * so GET requests still need a signature.
 *
 * `/health` is exempt so external uptime checks (and Phase 2 acceptance
 * tests) don't need the shared secret.
 */

export interface HmacEnv {
  DISPATCH_HMAC_SECRET: string;
}

const HEADER = "x-symphony-signature";
const EXEMPT_PATHS = new Set<string>(["/health"]);

export const hmacMiddleware: MiddlewareHandler<{ Bindings: HmacEnv }> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (EXEMPT_PATHS.has(path)) {
    return next();
  }

  const provided = c.req.header(HEADER);
  if (!provided) {
    return c.json({ error: "missing_signature" }, 401);
  }

  const secret = c.env.DISPATCH_HMAC_SECRET;
  if (!secret) {
    return c.json({ error: "dispatcher_misconfigured" }, 500);
  }

  // Read the raw body once and stash it on the request context. Downstream
  // handlers should use `c.req.raw.clone()` or rely on Hono's body parser,
  // which reads from the original request — we only consume a clone here.
  const bodyBytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());

  const expected = await computeSignature(secret, bodyBytes);
  if (!constantTimeEqual(expected, provided)) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  return next();
};

/**
 * Compute HMAC-SHA256(body) keyed by `secret`, returned as a lowercase hex
 * string. Exposed for tests and for clients that want to construct the same
 * signature inside the same Worker (none today; Symphony signs in Elixir).
 */
export async function computeSignature(
  secret: string,
  body: Uint8Array | string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const data = typeof body === "string" ? enc.encode(body) : body;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));

  let out = "";
  for (const byte of sig) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Constant-time string equality. Hex strings only — both inputs must be
 * the same length to compare, otherwise we still walk the longer one to
 * avoid leaking length information through timing.
 */
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
