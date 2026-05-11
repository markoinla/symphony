// Bearer token auth for /api/v1/* — parses `Authorization: Bearer <tok>`,
// hashes via SHA-256, and looks up the result in `api_tokens`. Issuance
// (POST /api/v1/tokens, scope grant, dashboard UI) ships in SYM-296.
// Until then the table is empty, so every presented token resolves to
// null — exactly the behavior the Track 2 plan calls for.

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

  // Table exists (migration 0002_workflows.sql), but no rows are
  // written until SYM-296 lands the issuance flow. Until then this
  // lookup always misses and we return null → 401 at the caller.
  const row = await c.env.DB.prepare(
    "SELECT id, organization_id, name, token_hash, scopes, created_at, last_used_at FROM api_tokens WHERE token_hash = ?",
  )
    .bind(hash)
    .first<ApiTokenRow>()
    .catch(() => null);

  if (!row) return null;

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
