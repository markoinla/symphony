import { Hono } from "hono";
import type { Env } from "../index";
import { OAuthHelper } from "../lib/oauth-helper";
import { InstallationStore } from "../lib/store";

/**
 * OAuth routes for installing the agent into a Linear workspace.
 *
 * - `GET /oauth/authorize` → redirects to Linear's consent screen with
 *   `actor=app` so the install creates a dedicated agent user.
 * - `GET /oauth/callback` → exchanges the code for an access token and
 *   stores it in KV under `access_token`.
 * - `GET /oauth/revoke` → revokes the token at Linear and clears KV.
 *
 * Single-org for now: there's exactly one `access_token` key. Re-running
 * the authorize flow overwrites it. Multi-org support moves these into
 * D1 keyed by `organizationId` later.
 */

export function buildOAuthRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/oauth/authorize", async (c) => {
    const state = OAuthHelper.generateState();
    await c.env.LINEAR_TOKENS.put("oauth_state", state, {
      // 10-minute TTL on the state so abandoned flows don't accumulate.
      expirationTtl: 600,
    });

    const url = OAuthHelper.generateAuthorizationUrl(
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

    const stored = await c.env.LINEAR_TOKENS.get("oauth_state");
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

      // Look up the organization id so we can key the install by it.
      // Falls back to the legacy single-tenant KV path if the viewer
      // query fails (transient Linear API issue) — the next /oauth
      // run can heal the D1 row.
      let organizationId: string | null = null;
      try {
        organizationId = await OAuthHelper.fetchOrganizationId(
          token.access_token,
        );
      } catch (e) {
        console.error(
          "viewer_query_failed",
          e instanceof Error ? e.message : String(e),
        );
      }

      if (organizationId) {
        await new InstallationStore(c.env.DB).upsert(
          organizationId,
          token.access_token,
          token.scope,
        );
      }

      // Keep the legacy KV key in sync during the cutover so any code
      // path that still reads from it (none in production after item
      // 3, but tests + the legacy `runSession` still rely on it) keeps
      // working. Drop this once `runSession` is deleted.
      await c.env.LINEAR_TOKENS.put("access_token", token.access_token);
      await c.env.LINEAR_TOKENS.delete("oauth_state");

      return c.json({
        ok: true,
        message: "Agent installed. Mention or assign issues to it in Linear.",
        scope: token.scope,
        organization_id: organizationId,
      });
    } catch (e) {
      await c.env.LINEAR_TOKENS.delete("oauth_state");
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
    // Revoke either by query param `organization_id` or, when there's
    // exactly one install, the implicit only-install.
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

  return app;
}
