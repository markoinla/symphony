// Bearer token auth for /api/v1/* — parses `Authorization: Bearer <tok>`,
// hashes via SHA-256, and looks up the result in `api_tokens`. Tokens
// are issued via `POST /api/v1/api-tokens` (admin scope) and revoked
// via `DELETE /api/v1/api-tokens/:id`. The plaintext is only ever
// returned on the create response — only the hash lives in D1.

import type { Context } from "hono";

import type { Env } from "../../index";
import type { AuthContext } from "./context";

const BEARER_RE = /^Bearer\s+([A-Za-z0-9._\-+/=]+)$/;

interface ApiTokenRow {
  id: string;
  organization_id: string;
  name: string;
  token_hash: string;
  scopes: string | null;
  created_at: number;
  last_used_at: number | null;
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractBearer(c: Context<{ Bindings: Env }>): string | null {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header) return null;
  const m = BEARER_RE.exec(header.trim());
  return m?.[1] ?? null;
}

export async function tryBearerAuth(
  c: Context<{ Bindings: Env }>,
): Promise<AuthContext | null> {
  const token = extractBearer(c);
  if (!token) return null;

  const hash = await hashToken(token);

  const row = await c.env.DB.prepare(
    "SELECT id, organization_id, name, token_hash, scopes, created_at, last_used_at FROM api_tokens WHERE token_hash = ?",
  )
    .bind(hash)
    .first<ApiTokenRow>()
    .catch(() => null);

  if (!row) return null;

  // Best-effort last_used_at update. Wrapped in executionCtx.waitUntil
  // when available so the response doesn't wait on it; falls back to
  // fire-and-forget in environments (tests) without an ExecutionContext.
  const touch = c.env.DB.prepare(
    "UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
  )
    .bind(Math.floor(Date.now() / 1000), row.id)
    .run()
    .catch(() => {});
  const ctx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
  if (ctx?.waitUntil) ctx.waitUntil(touch);

  let scopes: string[] = [];
  if (row.scopes) {
    try {
      const parsed = JSON.parse(row.scopes) as unknown;
      if (Array.isArray(parsed)) {
        scopes = parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      scopes = [];
    }
  }

  return {
    actor: { kind: "token", id: row.id },
    scopes,
    orgId: row.organization_id,
  };
}
