import { Hono } from "hono";

import type { Env } from "../index";
import { AgentSessionEventStore, AgentSessionStore } from "../lib/store";
import { requireDashboardAuth, requireOrg } from "../lib/dashboard-auth";

export function buildDashboardRouter() {
  const router = new Hono<{ Bindings: Env }>();

  // ── Dashboard API routes (must precede the asset catch-all) ─────

  router.get("/dashboard/api/sessions", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const store = new AgentSessionStore(c.env.DB);
    const sessions = await store.list({
      organizationId: user.organizationId,
      team: c.req.query("team") || undefined,
      repo: c.req.query("repo") || undefined,
      status: c.req.query("status") || undefined,
      triggered_by: c.req.query("triggered_by") || undefined,
      limit: parseInt(c.req.query("limit") || "50", 10),
      offset: parseInt(c.req.query("offset") || "0", 10),
    });

    const rows = sessions.map((s) => ({
      id: s.id,
      linear_issue_id: s.linear_issue_id,
      linear_issue_title: s.linear_issue_title,
      status: s.status,
      started_at: s.started_at,
      completed_at: s.completed_at,
      triggered_by: s.triggered_by,
      team: s.team,
      repo: s.repo,
    }));

    return c.json({ sessions: rows });
  });

  router.get("/dashboard/api/sessions/live", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const orgId = user.organizationId;
    const store = new AgentSessionStore(c.env.DB);
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (data: unknown) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        };

        const sendHeartbeat = () => {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        };

        let closed = false;

        const poll = async () => {
          while (!closed) {
            try {
              const running = await store.listRunning(orgId);
              for (const session of running) {
                sendEvent({
                  type: "session_update",
                  session: {
                    id: session.id,
                    linear_issue_id: session.linear_issue_id,
                    linear_issue_title: session.linear_issue_title,
                    status: session.status,
                    started_at: session.started_at,
                    completed_at: session.completed_at,
                    triggered_by: session.triggered_by,
                    team: session.team,
                    repo: session.repo,
                  },
                });
              }
            } catch (e) {
              console.error(
                "sse_poll_error",
                e instanceof Error ? e.message : String(e),
              );
            }

            await new Promise((r) => setTimeout(r, 5000));
            sendHeartbeat();
          }
        };

        poll().catch(() => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        });

        try {
          const running = await store.listRunning(orgId);
          for (const session of running) {
            sendEvent({
              type: "session_update",
              session: {
                id: session.id,
                linear_issue_id: session.linear_issue_id,
                linear_issue_title: session.linear_issue_title,
                status: session.status,
                started_at: session.started_at,
                completed_at: session.completed_at,
                triggered_by: session.triggered_by,
                team: session.team,
                repo: session.repo,
              },
            });
          }
        } catch {}
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  router.get("/dashboard/api/sessions/:id/debug", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const store = new AgentSessionStore(c.env.DB);
    const session = await store.get(c.req.param("id"));
    if (!session || session.organization_id !== user.organizationId) {
      return c.json({ error: "not_found" }, 404);
    }

    const configSnapshot = session.config_snapshot
      ? JSON.parse(session.config_snapshot)
      : null;
    // Prefer the live timeline rows in `agent_session_events` — those
    // are written incrementally by the turn step so a running session
    // shows progress and a crashed run still has whatever streamed
    // before the failure. Fall back to the legacy `messages` JSON blob
    // on `agent_sessions` so historical sessions from before the
    // 0005 migration still render. Shape: `{ type, timestamp, body }`
    // matches the dashboard's existing translator in
    // dashboard/src/lib/api.ts:toTimelineSession.
    const eventStore = new AgentSessionEventStore(c.env.DB);
    const eventRows = await eventStore.listBySessionId(session.id);
    const messages =
      eventRows.length > 0
        ? eventRows.map((row) => ({
            type: row.type,
            timestamp: new Date(row.ts).toISOString(),
            body: row.body ?? undefined,
          }))
        : session.messages
          ? JSON.parse(session.messages)
          : [];
    const dispatcherLogs = session.dispatcher_logs
      ? JSON.parse(session.dispatcher_logs)
      : [];

    return c.json({
      id: session.id,
      linear_issue_id: session.linear_issue_id,
      linear_issue_title: session.linear_issue_title,
      status: session.status,
      started_at: session.started_at,
      completed_at: session.completed_at,
      triggered_by: session.triggered_by,
      team: session.team,
      repo: session.repo,
      prompt: session.prompt,
      config_snapshot: configSnapshot,
      stderr: session.stderr,
      dispatcher_logs: dispatcherLogs,
      messages,
      error: session.error,
    });
  });

  router.post("/dashboard/api/sessions/:id/rerun", async (c) => {
    const user = await requireOrg(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const store = new AgentSessionStore(c.env.DB);
    const session = await store.get(c.req.param("id"));
    if (!session || session.organization_id !== user.organizationId) {
      return c.json({ error: "not_found" }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
    const prompt = body.prompt || session.prompt;
    if (!prompt) return c.json({ error: "no_prompt" }, 400);

    const newSessionId = crypto.randomUUID();
    const configSnapshot = session.config_snapshot
      ? JSON.parse(session.config_snapshot)
      : null;

    await store.create({
      id: newSessionId,
      organizationId: user.organizationId,
      projectId: session.project_id,
      linearIssueId: session.linear_issue_id,
      linearIssueTitle: session.linear_issue_title,
      status: "running",
      triggeredBy: "rerun",
      team: session.team,
      repo: session.repo,
      prompt,
      configSnapshot,
    });

    try {
      await c.env.SESSION_RUNNER.create({
        id: newSessionId,
        params: {
          event: {
            type: "AgentSessionEvent" as const,
            action: "created" as const,
            webhookId: `rerun-${newSessionId}`,
            organizationId: undefined,
            agentSession: {
              id: newSessionId,
              issue: session.linear_issue_id
                ? {
                    id: session.linear_issue_id,
                    identifier: session.linear_issue_title ?? "",
                    title: session.linear_issue_title ?? "",
                    teamId: session.team ?? undefined,
                  }
                : undefined,
              promptContext: prompt,
            },
          },
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("rerun_workflow_create_failed", msg);
      await store
        .update(newSessionId, {
          status: "error",
          error: msg,
          completedAt: Math.floor(Date.now() / 1000),
        })
        .catch(() => {});
      return c.json({ error: "workflow_create_failed", message: msg }, 500);
    }

    return c.json({ ok: true, new_session_id: newSessionId });
  });

  // ── User info ───────────────────────────────────────────────────
  // Better Auth exposes /api/auth/get-session — this stays as a thin
  // shim for the legacy dashboard client which expects /dashboard/api/me.
  router.get("/dashboard/api/me", async (c) => {
    const user = await requireDashboardAuth(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json({
      id: user.userId,
      email: user.email,
      name: user.name,
      image: user.image,
      organizationId: user.organizationId,
    });
  });

  // ── Static asset serving with auth gate ────────────────────────

  router.get("/dashboard/login", (c) => serveIndex(c));
  router.get("/dashboard/login/*", (c) => serveIndex(c));
  router.get("/dashboard/signup", (c) => serveIndex(c));
  router.get("/dashboard/signup/*", (c) => serveIndex(c));

  router.get("/dashboard/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname;

    if (/\.(js|css|svg|png|jpg|ico|woff2?|ttf|map)$/i.test(path)) {
      return serveAsset(c);
    }

    const user = await requireDashboardAuth(c);
    if (user) return serveIndex(c);
    return c.redirect("/dashboard/login", 302);
  });

  router.get("/dashboard", async (c) => {
    const user = await requireDashboardAuth(c);
    if (user) return serveIndex(c);
    return c.redirect("/dashboard/login", 302);
  });

  return router;
}

async function serveAsset(c: {
  req: { raw: Request; url: string };
  env: { ASSETS: Fetcher };
}) {
  return c.env.ASSETS.fetch(c.req.raw);
}

async function serveIndex(c: {
  req: { raw: Request; url: string };
  env: { ASSETS: Fetcher };
}) {
  const url = new URL(c.req.url);
  url.pathname = "/dashboard/index.html";
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
}
