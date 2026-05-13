// Coarse scope enforcement for /api/v1/* mutations.
//
// `requireAuth` already proved the actor; this helper checks that the
// proven scope set covers the operation. Wildcard '*' grants everything
// (used today by the cookie session path — tokens get explicit scopes).
//
// Returns a 403 Response if the scope is missing, otherwise null so
// callers can `if (denied) return denied`.
//
// Scopes:
//   read   — all GETs
//   write  — mutations on workflows/triggers/projects/settings
//   admin  — token CRUD, integrations writes, destructive admin
//
// Full spec: docs/linear_agent_api_v1.md ("Auth → Scope matrix").

import type { Context, MiddlewareHandler } from "hono";

import { respondError } from "../responses";
import type { AuthContext, AuthVariables } from "./context";
import type { Env } from "../../index";

export type Scope = "read" | "write" | "admin";

export function hasScope(auth: AuthContext, scope: Scope): boolean {
  return auth.scopes.includes(scope) || auth.scopes.includes("*");
}

export function requireScope(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  scope: Scope,
): Response | null {
  const auth = c.get("auth");
  if (!auth) return respondError(c, "unauthorized");
  if (!hasScope(auth, scope)) {
    return respondError(
      c,
      "forbidden",
      `This operation requires the \`${scope}\` scope.`,
    );
  }
  return null;
}

// Route-group middleware. Map HTTP methods to scopes so the workflows /
// triggers / webhook-events routers can enforce read-on-GET +
// write-on-everything-else in one line. Methods absent from the map
// fall through unchecked (so OPTIONS pre-flight doesn't 403).
export function requireScopeForMethod(
  map: Partial<Record<"GET" | "POST" | "PUT" | "DELETE" | "PATCH", Scope>>,
): MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> {
  return async (c, next) => {
    const method = c.req.method as keyof typeof map;
    const scope = map[method];
    if (!scope) {
      await next();
      return;
    }
    const denied = requireScope(c, scope);
    if (denied) return denied;
    await next();
  };
}
