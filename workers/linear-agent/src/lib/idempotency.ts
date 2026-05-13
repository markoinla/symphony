// KV-backed idempotency for v1 mutating routes.
//
// When `Idempotency-Key: <client-uuid>` is present, the response is
// cached for 24h under `(org_id, route_key, idempotency_key)`. Duplicate
// requests within the window return the cached response byte-for-byte;
// the underlying side effect runs exactly once (race-permitting, see
// below).
//
// Race note: KV is eventually consistent. Two concurrent calls with the
// same key may both miss and both execute. We accept this — idempotency
// keys are a hint that defends against client retries, not a hard
// cross-region lock. For stricter semantics we'd reach for a D1 unique
// index, but for the v1 surface this is enough.
//
// Caching policy:
//   - Cache 2xx and 4xx responses (validation errors should be sticky
//     across retries so clients don't see different errors for the same
//     payload).
//   - Skip caching when response > 16KB (likely streaming/blob; idempotent
//     replay still works — the request just runs again).
//   - Skip caching for 5xx (a transient infra error is worth retrying).
//
// Full spec: docs/linear_agent_api_v1.md ("Conventions → Idempotency").

import type { Context } from "hono";

import type { AuthVariables } from "./auth/context";
import type { Env } from "../index";

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24h
const CACHE_MAX_BYTES = 16 * 1024;

interface CachedResponse {
  status: number;
  contentType: string | null;
  body: string;
}

export function getIdempotencyKey(c: Context): string | null {
  const raw = c.req.header("idempotency-key") ?? c.req.header("Idempotency-Key");
  if (!raw) return null;
  const trimmed = raw.trim();
  // Bound the key length — KV keys are capped at 512 bytes and we
  // prefix the stored key, so 200 leaves headroom.
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

function kvKey(orgId: string, routeKey: string, idemKey: string): string {
  return `idem:${orgId}:${routeKey}:${idemKey}`;
}

export async function withIdempotency(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  routeKey: string,
  exec: () => Promise<Response>,
): Promise<Response> {
  const idemKey = getIdempotencyKey(c);
  if (!idemKey) return exec();

  const auth = c.get("auth");
  if (!auth) return exec();

  const key = kvKey(auth.orgId, routeKey, idemKey);

  const cached = await c.env.LINEAR_TOKENS.get(key).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as CachedResponse;
      const headers: Record<string, string> = {
        "Idempotent-Replayed": "true",
      };
      if (parsed.contentType) headers["Content-Type"] = parsed.contentType;
      return new Response(parsed.body, { status: parsed.status, headers });
    } catch {
      // Bad cache row — fall through to a fresh execution.
    }
  }

  const response = await exec();
  await storeIfCacheable(c.env, key, response).catch(() => {
    // Idempotency cache is best-effort; never fail the request on KV errors.
  });
  return response;
}

async function storeIfCacheable(
  env: Env,
  key: string,
  response: Response,
): Promise<void> {
  if (response.status >= 500) return;
  const body = await response.clone().text();
  if (body.length > CACHE_MAX_BYTES) return;
  const payload: CachedResponse = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
  };
  await env.LINEAR_TOKENS.put(key, JSON.stringify(payload), {
    expirationTtl: IDEMPOTENCY_TTL_SECONDS,
  });
}
