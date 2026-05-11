import { Hono } from "hono";
import type { Env } from "../index";
import { OAuthHelper } from "../lib/oauth-helper";
import { buildSessionCookie } from "../lib/session-cookie";
import { InstallationStore, UserStore } from "../lib/store";

/**
 * OAuth routes for two distinct Linear flows:
 *
 *   Agent install (`actor=app`):
 *     - GET /oauth/authorize  → Linear consent with `actor=app`
 *     - GET /oauth/callback   → exchange code, upsert installation,
 *                                then redirect through the user-login
 *                                flow so the org always has at least
 *                                one working `actor=user` token.
 *     - GET /oauth/revoke     → revoke + clear KV/D1.
 *
 *   Dashboard login (`actor=user`):
 *     - GET /oauth/user/authorize  → Linear consent with no actor,
 *                                     `read,write` scopes.
 *     - GET /oauth/user/callback   → exchange code, upsert user,
 *                                     set signed session cookie,
 *                                     land at /dashboard.
 *
 * Both flows share the same Linear OAuth app (client id/secret). The
 * KV `oauth_state` key namespaces install state; `oauth_state_user`
 * namespaces user-login state so the two flows can't collide if an
 * operator hits authorize for both in different tabs.
 */

const STATE_KV_INSTALL = "oauth_state";
const STATE_KV_USER = "oauth_state_user";
const STATE_TTL_SECONDS = 600;

export function buildOAuthRouter() {
  const app = new Hono<{ Bindings: Env }>();

  // ----- Agent install flow (actor=app) -----

  app.get("/oauth/authorize", async (c) => {
    const state = OAuthHelper.generateState();
    await c.env.LINEAR_TOKENS.put(STATE_KV_INSTALL, state, {
      expirationTtl: STATE_TTL_SECONDS,
    });

    const url = OAuthHelper.generateAppInstallUrl(
      c.env.LINEAR_CLIENT_ID,
      `${c.env.URL}/oauth/callback`,
      state,
    );
    return c.redirect(url);
  });

  app.get("/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      return c.json({ error: "authorization_failed", details: error }, 400);
    }
    if (!code || !state) {
      return c.json({ error: "missing_parameters" }, 400);
    }

    const stored = await c.env.LINEAR_TOKENS.get(STATE_KV_INSTALL);
    if (!stored || stored !== state) {
      return c.json({ error: "invalid_state" }, 400);
    }

    try {
      const token = await OAuthHelper.exchangeCodeForToken(
        code,
        c.env.LINEAR_CLIENT_ID,
        c.env.LINEAR_CLIENT_SECRET,
        `${c.env.URL}/oauth/callback`,
      );

      // Look up the org so we can key the install by it. Falls back to
      // the legacy single-tenant KV path if the viewer query fails
      // (transient Linear API issue) — the next /oauth run heals D1.
      let organizationId: string | null = null;
      let organizationName: string | null = null;
      try {
        const profile = await OAuthHelper.fetchViewerProfile(
          token.access_token,
        );
        organizationId = profile.organizationId;
        organizationName = profile.organizationName;
      } catch (e) {
        console.error(
          "viewer_query_failed",
          e instanceof Error ? e.message : String(e),
        );
      }

      if (organizationId) {
        const expiresAt = new Date(
          Date.now() + token.expires_in * 1000,
        ).toISOString();
        await new InstallationStore(c.env.DB).upsert({
          organizationId,
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? null,
          scopes: token.scope,
          expiresAt,
          organizationName,
        });
      }

      // Keep the legacy KV key in sync during the cutover so any code
      // path that still reads from it keeps working until single-org
      // installs are fully migrated.
      await c.env.LINEAR_TOKENS.put("access_token", token.access_token);
      await c.env.LINEAR_TOKENS.delete(STATE_KV_INSTALL);

      // Send the installer through the user-actor login flow so the
      // org has a working Linear MCP bearer + dashboard session. The
      // user-callback writes `installations.installed_by_linear_user_id`
      // back-pointer when it sees a missing one.
      return c.redirect(`${c.env.URL}/oauth/user/authorize?installed=1`);
    } catch (e) {
      await c.env.LINEAR_TOKENS.delete(STATE_KV_INSTALL);
      return c.json(
        {
          error: "token_exchange_failed",
          message: e instanceof Error ? e.message : "unknown_error",
        },
        400,
      );
    }
  });

  app.get("/oauth/revoke", async (c) => {
    const orgQuery = c.req.query("organization_id");
    const store = new InstallationStore(c.env.DB);
    const install = orgQuery
      ? await store.get(orgQuery)
      : await store.getOnlyInstallation();
    const token =
      install?.access_token ??
      (await c.env.LINEAR_TOKENS.get("access_token"));
    if (!token) {
      return c.json({ error: "no_token" }, 400);
    }
    const res = await fetch("https://api.linear.app/oauth/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return c.json(
        { error: "revoke_failed", status: res.status, details: await res.text() },
        500,
      );
    }
    if (install) {
      await store.delete(install.organization_id);
    }
    await c.env.LINEAR_TOKENS.delete("access_token");
    return c.json({ ok: true });
  });

  // ----- Dashboard login flow (actor=user) -----

  app.get("/oauth/user/authorize", async (c) => {
    const state = OAuthHelper.generateState();
    await c.env.LINEAR_TOKENS.put(STATE_KV_USER, state, {
      expirationTtl: STATE_TTL_SECONDS,
    });
    const url = OAuthHelper.generateUserLoginUrl(
      c.env.LINEAR_CLIENT_ID,
      `${c.env.URL}/oauth/user/callback`,
      state,
    );
    return c.redirect(url);
  });

  app.get("/oauth/user/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      return c.json({ error: "authorization_failed", details: error }, 400);
    }
    if (!code || !state) {
      return c.json({ error: "missing_parameters" }, 400);
    }

    const stored = await c.env.LINEAR_TOKENS.get(STATE_KV_USER);
    if (!stored || stored !== state) {
      return c.json({ error: "invalid_state" }, 400);
    }

    try {
      const token = await OAuthHelper.exchangeCodeForToken(
        code,
        c.env.LINEAR_CLIENT_ID,
        c.env.LINEAR_CLIENT_SECRET,
        `${c.env.URL}/oauth/user/callback`,
      );

      const profile = await OAuthHelper.fetchViewerProfile(token.access_token);

      // Gate dashboard logins to members of an installed org. The
      // install upserts the org row first; if a user logs in for an
      // org we haven't installed yet, reject with a 403 rather than
      // creating an orphan user record.
      const installs = new InstallationStore(c.env.DB);
      const install = await installs.get(profile.organizationId);
      if (!install) {
        await c.env.LINEAR_TOKENS.delete(STATE_KV_USER);
        return c.json(
          {
            error: "not_an_installed_org",
            organization_id: profile.organizationId,
            hint: "Install the Symphony agent in this Linear workspace first.",
          },
          403,
        );
      }

      const expiresAt = new Date(
        Date.now() + token.expires_in * 1000,
      ).toISOString();
      const userId = crypto.randomUUID();
      const users = new UserStore(c.env.DB);
      // upsert by (org, linear_user_id); the id field is honored only
      // on first insert. Existing rows keep their original UUID so
      // session cookies issued earlier still resolve.
      const existing = await users.getByOrgAndLinearId(
        profile.organizationId,
        profile.id,
      );
      const finalId = existing?.id ?? userId;
      await users.upsert({
        id: finalId,
        organizationId: profile.organizationId,
        linearUserId: profile.id,
        email: profile.email,
        name: profile.name,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresAt,
        scopes: token.scope,
      });

      // First-login installer back-pointer: if the install has no
      // `installed_by_linear_user_id` (i.e. this is the user who just
      // came through the post-install redirect), stamp them as the
      // installer.
      if (
        c.req.query("installed") === "1" &&
        !install.installed_by_linear_user_id
      ) {
        await installs.upsert({
          organizationId: profile.organizationId,
          accessToken: install.access_token,
          scopes: install.scopes,
          installedByLinearUserId: profile.id,
        });
      }

      await c.env.LINEAR_TOKENS.delete(STATE_KV_USER);

      const cookie = await buildSessionCookie(c.env, {
        uid: finalId,
        oid: profile.organizationId,
      });
      // Redirect into the dashboard SPA root; Phase 7 serves it from
      // /dashboard. Until then the response itself doubles as a
      // human-readable confirmation.
      const redirect = c.env.URL ? `${c.env.URL}/dashboard` : "/dashboard";
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirect,
          "Set-Cookie": cookie,
        },
      });
    } catch (e) {
      await c.env.LINEAR_TOKENS.delete(STATE_KV_USER);
      return c.json(
        {
          error: "user_token_exchange_failed",
          message: e instanceof Error ? e.message : "unknown_error",
        },
        400,
      );
    }
  });

  return app;
}
