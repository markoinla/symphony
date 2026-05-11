// Dashboard auth middleware — thin wrapper over Better Auth's session
// lookup. The Better Auth handler is mounted at `/api/auth/*` in
// src/index.ts and sets a `better-auth.session_token` cookie on login.
// We resolve that cookie to a tenant context (user + active org) on
// every protected request.
//
// `requireOrg` delegates to the unified `resolveAuth` in
// src/lib/auth/context.ts so cookie-vs-bearer is one decision instead
// of two. Dashboard API callers always hit the cookie path, but the
// shared resolver keeps `/api/v1/*` and `/dashboard/api/*` from
// drifting on auth semantics.

import type { Context } from "hono";

import type { Env } from "../index";
import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { createAuth } from "./auth";
import { resolveAuth } from "./auth/context";

export interface DashboardUser {
  userId: string;
  organizationId: string | null;
  email: string;
  name: string | null;
  image: string | null;
}

export async function requireDashboardAuth(
  c: Context<{ Bindings: Env }>,
): Promise<DashboardUser | null> {
  const auth = createAuth(
    c.env,
    (c.req.raw as { cf?: IncomingRequestCfProperties }).cf,
    c.env.URL,
  );

  try {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (!session) return null;

    return {
      userId: session.user.id,
      organizationId:
        (session.session as { activeOrganizationId?: string | null })
          .activeOrganizationId ?? null,
      email: session.user.email,
      name: session.user.name ?? null,
      image: session.user.image ?? null,
    };
  } catch (e) {
    console.error(
      "auth_lookup_error",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

// requireOrg() — gate for tenant-scoped dashboard API endpoints. Runs
// through `resolveAuth` so the same decision tree owns both the
// session-cookie and (future) bearer-token surfaces. Dashboard
// callers continue to need user-level identity (email/name/image) so
// we reject when the resolved actor is a token rather than a user.
export async function requireOrg(
  c: Context<{ Bindings: Env }>,
): Promise<(DashboardUser & { organizationId: string }) | null> {
  const auth = await resolveAuth(c);
  if (!auth) return null;
  if (auth.actor.kind !== "user") return null;

  // Re-fetch the user-level details Better Auth surfaces. resolveAuth
  // already validated the cookie, so this is the same lookup with the
  // result we discarded on the first pass.
  const user = await requireDashboardAuth(c);
  if (!user || !user.organizationId) return null;
  return user as DashboardUser & { organizationId: string };
}
