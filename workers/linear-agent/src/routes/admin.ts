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
import {
  DispatcherClient,
  DispatcherError,
  type NormalizedEvent,
} from "../lib/dispatcher";
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
        `SELECT organization_id, scopes, github_app_installation_id, installed_at, refreshed_at
         FROM installations ORDER BY installed_at DESC`,
      )
      .all<{
        organization_id: string;
        scopes: string;
        github_app_installation_id: number | null;
        installed_at: string;
        refreshed_at: string;
      }>();
    const installations = result.results.map((row) => ({
      organization_id: row.organization_id,
      scopes: row.scopes,
      github_app_installation_id: row.github_app_installation_id,
      installed_at: row.installed_at,
      refreshed_at: row.refreshed_at,
    }));
    return c.json({ installations });
  });

  /**
   * Smoke-test the worker → dispatcher SSE wire without needing a
   * real Linear delivery or a seeded auth backup. Signs a /run
   * request with a deliberately-unknown scope so the dispatcher's
   * streaming branch hits the `missing_auth_backup` path early —
   * which is the desired outcome: it exercises every layer of the
   * wire (HMAC signing/verification, SSE framing, line buffering,
   * NormalizedEvent parsing) and exits in seconds.
   *
   * Expected on a healthy wire: at least one `error` event + a
   * `result` event with non-zero exit_code, total events ≥ 2.
   *
   * Use after deploys to confirm both workers can talk to each
   * other and the SSE plumbing is intact before triggering a real
   * Agent Session in Linear.
   */
  app.get("/admin/smoke", async (c) => {
    const startedAt = Date.now();
    const events: NormalizedEvent[] = [];
    let connectError: string | null = null;

    try {
      const dispatcher = new DispatcherClient(
        c.env.DISPATCHER_URL,
        c.env.DISPATCH_HMAC_SECRET,
      );
      for await (const ev of dispatcher.runStream({
        scope: "smoke-test-no-such-scope",
        issueId: "smoke-test",
        repoUrl: "https://github.com/markoinla/symphony.git",
        prompt: "smoke test — should never run",
        engine: "pi",
        model: null,
      })) {
        events.push(ev);
        // Safety brake: a healthy dispatcher exits in ≤3 events; cap
        // at 50 so a misbehaving dispatcher can't hold the
        // connection forever.
        if (events.length > 50) break;
      }
    } catch (e) {
      connectError =
        e instanceof DispatcherError
          ? `dispatcher_${e.status}: ${typeof e.body === "string" ? e.body : e.body.error}`
          : e instanceof Error
            ? e.message
            : "unknown_connect_error";
    }

    const finalEvent = events[events.length - 1] ?? null;
    const sseWireOk =
      connectError === null &&
      events.some((e) => e.type === "result") &&
      events.some((e) => e.type === "error");

    return c.json({
      sse_wire_ok: sseWireOk,
      duration_ms: Date.now() - startedAt,
      events_received: events.length,
      event_types: events.map((e) => e.type),
      final_event: finalEvent,
      connect_error: connectError,
    });
  });

  return app;
}

// Re-export so consumers can read installation tokens for tests etc.
export { InstallationStore };
