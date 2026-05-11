// Unified auth context for the linear-agent Worker.
//
// Two credential surfaces:
//   - Better Auth session cookie  → actor.kind = 'user', actor.id = userId
//   - Authorization: Bearer <tok> → actor.kind = 'token', actor.id = apiTokenId
//
// `requireAuth` is the single entry point. It tries the session cookie
// first (so the dashboard keeps working unchanged), then falls through
// to the bearer middleware. On success it sets `c.var.auth` and returns
// the `AuthContext`; on failure it returns null and the caller responds
// 401.

import type { Context, MiddlewareHandler } from "hono";

import type { Env } from "../../index";
import { requireDashboardAuth } from "../dashboard-auth";
import { tryBearerAuth } from "./bearer";

export interface AuthContext {
  actor: { kind: "user" | "token"; id: string };
  scopes: string[];
  orgId: string;
}

// Hono variable map. Cast at the route layer with
// `Variables: AuthVariables` if you want type-safe `c.get('auth')`.
export interface AuthVariables {
  auth: AuthContext;
}

// `resolveAuth` accepts any Hono context bound to our Env, including
// ones that carry extra Variables. The two downstream helpers are
// typed for the narrower `{ Bindings: Env }` shape; we cast at the
// boundary so callers with `Variables: AuthVariables` (the /api/v1
// router) compile without a stack of generics here.
export async function resolveAuth(
  c: Context<{ Bindings: Env }>,
): Promise<AuthContext | null> {
  // 1) Session cookie path. Better Auth's organization plugin tracks
  //    activeOrganizationId on the session row; we surface it as orgId.
  const user = await requireDashboardAuth(c);
  if (user && user.organizationId) {
    return {
      actor: { kind: "user", id: user.userId },
      // Dashboard users get the full surface; downstream handlers may
      // narrow on resource ownership.
      scopes: ["*"],
      orgId: user.organizationId,
    };
  }

  // 2) Bearer token path. Returns null today (api_tokens is empty
  //    until SYM-296 ships issuance).
  const bearer = await tryBearerAuth(c);
  if (bearer) return bearer;

  return null;
}

export function requireAuth(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    const auth = await resolveAuth(c as unknown as Context<{ Bindings: Env }>);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    c.set("auth", auth);
    await next();
  };
}
