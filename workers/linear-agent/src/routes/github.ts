/**
 * GitHub App install flow + PAT fallback routes.
 *
 * Install flow:
 *   GET  /github/install          → redirect to GitHub App install page
 *   GET  /github/install/callback → handle post-install callback, store in D1
 *
 * PAT fallback (admin-gated):
 *   PUT    /admin/credentials/:orgId/github_pat  → encrypt + store PAT
 *   DELETE /admin/credentials/:orgId/github_pat  → remove stored PAT
 *   GET    /admin/credentials/:orgId             → list credential types (no values)
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { CredentialStore } from "../lib/credentials";
import { createAppJwt } from "../lib/github-app";
import { InstallationStore } from "../lib/store";

export function buildGitHubRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/github/install", (c) => {
    const slug = c.env.GITHUB_APP_SLUG;
    if (!slug) {
      return c.json({ error: "github_app_not_configured" }, 503);
    }
    const state = crypto.randomUUID();
    return c.redirect(
      `https://github.com/apps/${slug}/installations/new?state=${state}`,
    );
  });

  app.get("/github/install/callback", async (c) => {
    const installationId = c.req.query("installation_id");
    const setupAction = c.req.query("setup_action");

    if (!installationId) {
      return c.json({ error: "missing_installation_id" }, 400);
    }

    if (setupAction === "request") {
      return c.json({
        ok: false,
        message:
          "Installation request submitted — an org admin must approve it.",
      });
    }

    const ghInstallId = parseInt(installationId, 10);
    if (isNaN(ghInstallId)) {
      return c.json({ error: "invalid_installation_id" }, 400);
    }

    const appId = c.env.GITHUB_APP_ID;
    const privateKey = c.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) {
      return c.json({ error: "github_app_not_configured" }, 503);
    }

    let accountLogin = "unknown";

    try {
      const jwt = await createAppJwt(appId, privateKey);
      const res = await fetch(
        `https://api.github.com/app/installations/${ghInstallId}`,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "symphony-github-app",
          },
        },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          account?: { login?: string };
        };
        accountLogin = data.account?.login ?? accountLogin;
      }
    } catch {
      // Non-fatal: we still store the install_id even if the lookup fails
    }

    const orgId = c.req.query("org_id") ?? accountLogin;

    const store = new InstallationStore(c.env.DB);
    await store.updateGitHubAppInstallation(orgId, ghInstallId);

    return c.json({
      ok: true,
      message: "GitHub App installed.",
      installation_id: ghInstallId,
      account_login: accountLogin,
    });
  });

  // --- Admin-gated PAT credential routes ---

  app.use("/admin/credentials/*", async (c, next) => {
    const expected = c.env.ADMIN_TOKEN;
    if (!expected) return c.json({ error: "admin_disabled" }, 403);
    const provided = c.req.header("authorization");
    if (provided !== `Bearer ${expected}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.put("/admin/credentials/:orgId/github_pat", async (c) => {
    const kek = c.env.CREDENTIAL_KEK;
    if (!kek) {
      return c.json({ error: "encryption_not_configured" }, 503);
    }

    const body = (await c.req.json().catch(() => null)) as {
      token?: string;
    } | null;
    if (!body?.token || typeof body.token !== "string") {
      return c.json({ error: "missing_token" }, 400);
    }

    const orgId = c.req.param("orgId");
    const credStore = new CredentialStore(c.env.DB);
    await credStore.encryptForOrg(orgId, "github_pat", body.token, kek);

    return c.json({ ok: true, org_id: orgId, credential_type: "github_pat" });
  });

  app.delete("/admin/credentials/:orgId/github_pat", async (c) => {
    const credStore = new CredentialStore(c.env.DB);
    const removed = await credStore.delete(c.req.param("orgId"), "github_pat");
    return c.json({ ok: removed });
  });

  app.get("/admin/credentials/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    const credStore = new CredentialStore(c.env.DB);
    const kinds = await credStore.listKinds(orgId);
    return c.json({ org_id: orgId, credential_types: kinds });
  });

  return app;
}
