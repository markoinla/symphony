import { Hono } from "hono";
import type { Env } from "../index";
import { OAuthHelper } from "../lib/oauth-helper";

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
      await c.env.LINEAR_TOKENS.put("access_token", token.access_token);
      await c.env.LINEAR_TOKENS.delete("oauth_state");

      return c.json({
        ok: true,
        message: "Agent installed. Mention or assign issues to it in Linear.",
        scope: token.scope,
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
    const token = await c.env.LINEAR_TOKENS.get("access_token");
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
    await c.env.LINEAR_TOKENS.delete("access_token");
    return c.json({ ok: true });
  });

  return app;
}
