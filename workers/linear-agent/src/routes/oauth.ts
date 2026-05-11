// Linear Agent install flow (actor=app OAuth).
//
// This is NOT a user login flow — Better Auth at `/api/auth/*` handles
// password sign-in plus GitHub and Linear *user* OAuth. This flow exists
// to install the Linear Agent into a Linear workspace, granting the
// agent its own `actor=app` access token so it can read webhooks and
// post agent activities.
//
// Requirements before starting the install:
//   - Authenticated Better Auth session (cookie)
//   - Session has an active Better Auth organization
//
// Routes:
//   GET  /linear/agent-install            — redirect to Linear consent
//   GET  /linear/agent-install/callback   — exchange code, write D1
//   POST /linear/agent-install/revoke     — revoke + delete D1 row
//
// The legacy `/oauth/authorize`, `/oauth/callback`, `/oauth/user/*`,
// `/oauth/revoke`, and `/oauth/github/install-callback` routes are
// retired — Better Auth replaces them.

import { Hono } from "hono";

import type { Env } from "../index";
import { requireOrg } from "../lib/dashboard-auth";
import { OAuthHelper } from "../lib/oauth-helper";
import { LinearAgentInstallStore } from "../lib/store";

const STATE_TTL_S = 600;

export function buildOAuthRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/linear/agent-install", async (c) => {
    const user = await requireOrg(c);
    if (!user) {
      return c.json(
        { error: "unauthorized", message: "Sign in and select an organization first." },
        401,
      );
    }
    if (!c.env.LINEAR_CLIENT_ID) {
      return c.json({ error: "linear_not_configured" }, 503);
    }

    const state = OAuthHelper.generateState();
    // Bind state ↔ user's active organization so the callback knows
    // which Better Auth org to attach the install to.
    await c.env.LINEAR_TOKENS.put(
      `linear_install_state:${state}`,
      JSON.stringify({ orgId: user.organizationId, userId: user.userId }),
      { expirationTtl: STATE_TTL_S },
    );

    const url = OAuthHelper.generateAuthorizationUrl(
      c.env.LINEAR_CLIENT_ID,
      `${c.env.URL}/linear/agent-install/callback`,
      state,
    );
    return c.redirect(url);
  });

  app.get("/linear/agent-install/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      return c.json({ error: "authorization_failed", details: error }, 400);
    }
    if (!code || !state) {
      return c.json({ error: "missing_parameters" }, 400);
    }

    const stateRaw = await c.env.LINEAR_TOKENS.get(
      `linear_install_state:${state}`,
    );
    if (!stateRaw) {
      return c.json({ error: "invalid_state" }, 400);
    }
    await c.env.LINEAR_TOKENS.delete(`linear_install_state:${state}`);

    let stateData: { orgId: string; userId: string };
    try {
      stateData = JSON.parse(stateRaw);
    } catch {
      return c.json({ error: "corrupt_state" }, 400);
    }

    if (!c.env.LINEAR_CLIENT_ID || !c.env.LINEAR_CLIENT_SECRET) {
      return c.json({ error: "linear_not_configured" }, 503);
    }

    try {
      const token = await OAuthHelper.exchangeCodeForToken(
        code,
        c.env.LINEAR_CLIENT_ID,
        c.env.LINEAR_CLIENT_SECRET,
        `${c.env.URL}/linear/agent-install/callback`,
      );

      const linearOrgId = await OAuthHelper.fetchOrganizationId(
        token.access_token,
      );
      if (!linearOrgId) {
        return c.json(
          {
            error: "org_lookup_failed",
            message:
              "Could not resolve Linear organization. Please retry the install.",
          },
          502,
        );
      }

      await new LinearAgentInstallStore(c.env.DB).upsert({
        organizationId: stateData.orgId,
        linearOrganizationId: linearOrgId,
        accessToken: token.access_token,
        refreshToken: (token as { refresh_token?: string }).refresh_token,
        scopes: token.scope,
        installedByUserId: stateData.userId,
      });

      return c.redirect("/dashboard/settings?oauth=success");
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown_error";
      return c.redirect(
        `/dashboard/settings?oauth=error&message=${encodeURIComponent(message)}`,
      );
    }
  });

  app.post("/linear/agent-install/revoke", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const store = new LinearAgentInstallStore(c.env.DB);
    const install = await store.getByOrgId(user.organizationId);
    if (!install) {
      return c.json({ error: "not_installed" }, 404);
    }

    try {
      await fetch("https://api.linear.app/oauth/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${install.access_token}` },
      });
    } catch {
      // Best-effort revoke; still drop the row.
    }

    await store.delete(user.organizationId);
    return c.json({ ok: true });
  });

  return app;
}
