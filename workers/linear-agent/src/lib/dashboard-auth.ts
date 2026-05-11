// Dashboard auth middleware — thin wrapper over Better Auth's session
// lookup. The Better Auth handler is mounted at `/api/auth/*` in
// src/index.ts and sets a `better-auth.session_token` cookie on login.
// We resolve that cookie to a tenant context (user + active org) on
// every protected request.

import type { Context } from "hono";

import type { Env } from "../index";
import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { createAuth } from "./auth";

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

// requireOrg() — like requireDashboardAuth but additionally rejects
// when the session has no active organization. Used by tenant-scoped
// dashboard API endpoints.
export async function requireOrg(
  c: Context<{ Bindings: Env }>,
): Promise<(DashboardUser & { organizationId: string }) | null> {
  const user = await requireDashboardAuth(c);
  if (!user || !user.organizationId) return null;
  return user as DashboardUser & { organizationId: string };
}
