/**
 * Admin routes for managing D1-backed project + installation rows.
 *
 * Gated by an `Authorization: Bearer <ADMIN_TOKEN>` header. When
 * `ADMIN_TOKEN` is unset, all `/admin/*` routes 403 — that's the
 * default for unconfigured deployments. Symphony's Phoenix dashboard
 * doesn't exist here; this is the minimal operator surface for
 * seeding the DB.
 *
 * Project schema:
 *   POST   /admin/projects   { team_id, repo_url, default_branch?, engine?, model?, max_turns? }
 *   GET    /admin/projects
 *   GET    /admin/projects/:teamId
 *   DELETE /admin/projects/:teamId
 *
 * Installations are written by the OAuth flow, not here, but a
 * read-only list helps debug "which orgs are installed?" without
 * shelling into `wrangler d1 execute`.
 *
 *   GET    /admin/installations
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { InstallationStore, ProjectStore } from "../lib/store";

const AUTH_HEADER = "authorization";

export function buildAdminRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.use("/admin/*", async (c, next) => {
    const expected = c.env.ADMIN_TOKEN;
    if (!expected) {
      return c.json({ error: "admin_disabled" }, 403);
    }
    const provided = c.req.header(AUTH_HEADER);
    if (provided !== `Bearer ${expected}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get("/admin/projects", async (c) => {
    const rows = await new ProjectStore(c.env.DB).list();
    return c.json({ projects: rows });
  });

  app.get("/admin/projects/:teamId", async (c) => {
    const row = await new ProjectStore(c.env.DB).get(c.req.param("teamId"));
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ project: row });
  });

  app.post("/admin/projects", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | {
          team_id?: string;
          repo_url?: string;
          default_branch?: string;
          engine?: string;
          model?: string | null;
          max_turns?: number;
        }
      | null;
    if (!body || typeof body.team_id !== "string" || body.team_id.length === 0) {
      return c.json({ error: "invalid_team_id" }, 400);
    }
    if (typeof body.repo_url !== "string" || !/^https?:\/\//.test(body.repo_url)) {
      return c.json({ error: "invalid_repo_url" }, 400);
    }
    await new ProjectStore(c.env.DB).upsert({
      teamId: body.team_id,
      repoUrl: body.repo_url,
      defaultBranch: body.default_branch,
      engine: body.engine,
      model: body.model ?? null,
      maxTurns: body.max_turns,
    });
    const stored = await new ProjectStore(c.env.DB).get(body.team_id);
    return c.json({ ok: true, project: stored });
  });

  app.delete("/admin/projects/:teamId", async (c) => {
    const removed = await new ProjectStore(c.env.DB).delete(
      c.req.param("teamId"),
    );
    return c.json({ ok: removed });
  });

  app.get("/admin/installations", async (c) => {
    // Don't leak access tokens here — return scopes + timestamps only.
    // We SELECT just the safe columns AND strip the token field in JS
    // as defense-in-depth, so an accidental SELECT * elsewhere can't
    // leak credentials.
    const result = await c.env.DB
      .prepare(
        `SELECT organization_id, scopes, installed_at, refreshed_at
         FROM installations ORDER BY installed_at DESC`,
      )
      .all<{
        organization_id: string;
        access_token?: string;
        scopes: string;
        installed_at: string;
        refreshed_at: string;
      }>();
    const installations = result.results.map((row) => ({
      organization_id: row.organization_id,
      scopes: row.scopes,
      installed_at: row.installed_at,
      refreshed_at: row.refreshed_at,
    }));
    return c.json({ installations });
  });

  return app;
}

// Re-export so consumers can read installation tokens for tests etc.
export { InstallationStore };
