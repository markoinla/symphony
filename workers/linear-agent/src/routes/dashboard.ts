import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../index";
import {
  AgentSessionStore,
  CredentialStore,
  InstallationStore,
  SessionStore,
  type UserRecord,
} from "../lib/store";

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function requireDashboardUser(
  c: Context<{ Bindings: Env }>,
): Promise<UserRecord | Response> {
  const token = parseCookie(c.req.header("cookie"), "dashboard_session");
  if (!token) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const user = await new SessionStore(c.env.DB).validate(token);
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  return user;
}

function sessionCookie(
  token: string,
  maxAgeSec: number,
  secure: boolean,
): string {
  const parts = [
    `dashboard_session=${token}`,
    `Path=/dashboard`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("deleted", 0, secure);
}

export function setSessionCookie(
  token: string,
  ttlDays: number,
  secure: boolean,
): string {
  return sessionCookie(token, ttlDays * 86_400, secure);
}

export function buildDashboardRouter() {
  const router = new Hono<{ Bindings: Env }>();

  // --- Dashboard API routes (must be registered before the asset catch-all) ---

  router.get("/dashboard/api/sessions", async (c) => {
    const store = new AgentSessionStore(c.env.DB);
    const sessions = await store.list({
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
              const running = await store.listRunning();
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

            // Wait 5 seconds between polls
            await new Promise((r) => setTimeout(r, 5000));

            // Send heartbeat every 30s (6 poll cycles)
            sendHeartbeat();
          }
        };

        poll().catch(() => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        });

        // Cloudflare Workers have a 30s execution limit for streaming
        // responses. We rely on the client to reconnect. Send an initial
        // snapshot immediately.
        try {
          const running = await store.listRunning();
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
    const store = new AgentSessionStore(c.env.DB);
    const session = await store.get(c.req.param("id"));
    if (!session) {
      return c.json({ error: "not_found" }, 404);
    }

    const configSnapshot = session.config_snapshot
      ? JSON.parse(session.config_snapshot)
      : null;
    const messages = session.messages ? JSON.parse(session.messages) : [];
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
    const store = new AgentSessionStore(c.env.DB);
    const session = await store.get(c.req.param("id"));
    if (!session) {
      return c.json({ error: "not_found" }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      prompt?: string;
    };
    const prompt = body.prompt || session.prompt;
    if (!prompt) {
      return c.json({ error: "no_prompt" }, 400);
    }

    const newSessionId = crypto.randomUUID();

    // Create the new session record
    const configSnapshot = session.config_snapshot
      ? JSON.parse(session.config_snapshot)
      : null;

    await store.create({
      id: newSessionId,
      linearIssueId: session.linear_issue_id,
      linearIssueTitle: session.linear_issue_title,
      status: "running",
      triggeredBy: "rerun",
      team: session.team,
      repo: session.repo,
      prompt,
      configSnapshot,
    });

    // Re-dispatch through the webhook path by creating a synthetic
    // AgentSessionEvent and scheduling the workflow.
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
          completedAt: new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""),
        })
        .catch(() => {});
      return c.json({ error: "workflow_create_failed", message: msg }, 500);
    }

    return c.json({ ok: true, new_session_id: newSessionId });
  });

  // --- Integrations API routes ---

  router.get("/dashboard/api/integrations", async (c) => {
    const userOrRes = await requireDashboardUser(c);
    if (userOrRes instanceof Response) return userOrRes;
    const user = userOrRes;
    const orgId = user.organization_id;

    const installStore = new InstallationStore(c.env.DB);
    const credStore = new CredentialStore(c.env.DB);

    const installation = await installStore.getByOrgId(orgId);
    const configuredKinds = await credStore.listKinds(orgId);
    const configuredSet = new Set(configuredKinds);

    return c.json({
      linear: {
        connected: !!installation,
        email: user.email ?? null,
      },
      github: {
        connected: !!installation?.github_app_installation_id,
        repo_count: 0,
      },
      anthropic: { configured: configuredSet.has("anthropic") },
      openai: { configured: configuredSet.has("openai") },
      cf_workers_ai: { configured: configuredSet.has("cf_workers_ai") },
      github_app_settings_url: c.env.GITHUB_APP_SETTINGS_URL ?? null,
    });
  });

  router.put("/dashboard/api/integrations/credentials", async (c) => {
    const userOrRes = await requireDashboardUser(c);
    if (userOrRes instanceof Response) return userOrRes;
    const user = userOrRes;

    const body = await c.req.json<{ provider?: string; api_key?: string }>();
    const validProviders = ["anthropic", "openai", "cf_workers_ai"];
    if (
      !body.provider ||
      !validProviders.includes(body.provider) ||
      !body.api_key ||
      typeof body.api_key !== "string" ||
      body.api_key.trim().length === 0
    ) {
      return c.json(
        { error: "invalid_request", message: "provider and api_key are required" },
        400,
      );
    }

    const credStore = new CredentialStore(c.env.DB);
    await credStore.upsert(user.organization_id, body.provider, body.api_key.trim());
    return c.json({ ok: true });
  });

  // --- Auth API routes ---

  router.get("/dashboard/api/me", async (c) => {
    const cookieHeader = c.req.header("cookie");
    const token = parseCookie(cookieHeader, "dashboard_session");
    if (!token) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    const user = await new SessionStore(c.env.DB).validate(token);
    if (!user) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    return c.json({
      id: user.linear_user_id,
      email: user.email,
      name: user.name,
      avatarUrl: null,
    });
  });

  router.post("/dashboard/logout", async (c) => {
    const cookieHeader = c.req.header("cookie");
    const token = parseCookie(cookieHeader, "dashboard_session");
    if (token) {
      await new SessionStore(c.env.DB).delete(token);
    }
    const secure = new URL(c.req.url).protocol === "https:";
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/dashboard/login",
        "Set-Cookie": clearSessionCookie(secure),
      },
    });
  });

  // --- Static asset serving with auth gate ---

  router.get("/dashboard/login", async (c) => {
    return serveAsset(c);
  });

  router.get("/dashboard/login/*", async (c) => {
    return serveAsset(c);
  });

  router.get("/dashboard/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname;

    // Allow static assets through without auth (JS, CSS, images, fonts)
    if (/\.(js|css|svg|png|jpg|ico|woff2?|ttf|map)$/i.test(path)) {
      return serveAsset(c);
    }

    const cookieHeader = c.req.header("cookie");
    const token = parseCookie(cookieHeader, "dashboard_session");
    if (token) {
      const user = await new SessionStore(c.env.DB).validate(token);
      if (user) {
        return serveAsset(c);
      }
    }

    return c.redirect("/dashboard/login", 302);
  });

  router.get("/dashboard", async (c) => {
    const cookieHeader = c.req.header("cookie");
    const token = parseCookie(cookieHeader, "dashboard_session");
    if (token) {
      const user = await new SessionStore(c.env.DB).validate(token);
      if (user) {
        return serveAsset(c);
      }
    }
    return c.redirect("/dashboard/login", 302);
  });

  return router;
}

async function serveAsset(c: {
  req: { raw: Request; url: string };
  env: { ASSETS: Fetcher };
}) {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.status === 404) {
    const url = new URL(c.req.url);
    url.pathname = "/dashboard/index.html";
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  }
  return response;
}
