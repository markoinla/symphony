import { Hono } from "hono";
import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";

import { createAuth } from "./lib/auth";
import { reconcileZombieSessions } from "./lib/reconciler";
import { buildAdminRouter } from "./routes/admin";
import { buildApiV1Router } from "./routes/api-v1";
import { buildDashboardApiRouter } from "./routes/dashboard-api";
import { buildDashboardRouter } from "./routes/dashboard";
import { buildGitHubRouter } from "./routes/github";
import { buildInternalRouter } from "./routes/internal";
import { buildMcpRouter } from "./routes/mcp";
import { buildOAuthRouter } from "./routes/oauth";
import { buildOpenApiRouter } from "./routes/openapi";
import { buildWebhookRouter } from "./routes/webhook";

export interface Env {
  // Static assets for the dashboard SPA (served at /dashboard/*)
  ASSETS: Fetcher;

  // KV namespace storing OAuth state nonces and webhook delivery
  // dedupe markers. Install access tokens live in D1 `installations`.
  LINEAR_TOKENS: KVNamespace;

  // Cloudflare Workflow binding for SessionRunner — drives a single
  // Agent Session through load → thought → dispatch → terminal with
  // per-step durability. See src/workflows/session-runner.ts.
  SESSION_RUNNER: Workflow;

  // D1 database with `installations` + `projects` tables. See
  // migrations/0001_init.sql and src/lib/store.ts.
  DB: D1Database;

  // Linear OAuth + webhook secrets
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  LINEAR_WEBHOOK_SECRET: string;

  // Sandbox dispatcher
  DISPATCHER_URL: string;
  DISPATCH_HMAC_SECRET: string;

  // Public origin of this worker (used to build OAuth callback URL)
  URL: string;

  // Run defaults — used when no per-project D1 row exists yet.
  DEFAULT_SCOPE: string;
  DEFAULT_MODEL: string;
  DEFAULT_ENGINE: string;
  DEFAULT_THINKING_LEVEL?: string;
  // Max turns per session. Project rows override this. Defaults to 10
  // when neither is present.
  DEFAULT_MAX_TURNS?: string;

  // Shared secret guarding `/admin/*` routes (project CRUD). Set with
  // `wrangler secret put ADMIN_TOKEN`. When unset, admin routes 403.
  ADMIN_TOKEN?: string;

  // GitHub PAT used by the post-dispatch step to create the PR and
  // apply the `symphony` label. Set with
  // `wrangler secret put GITHUB_TOKEN`. When unset, the workflow
  // posts the branch info as a thought but skips PR creation.
  // Deprecated: prefer Symphony GitHub App (GITHUB_APP_ID +
  // GITHUB_APP_PRIVATE_KEY) which mints per-org installation tokens.
  GITHUB_TOKEN?: string;

  // Symphony GitHub App credentials. When present, per-org
  // installation tokens are minted via the GitHub App instead of
  // using the org-wide GITHUB_TOKEN PAT. Set with:
  //   wrangler secret put GITHUB_APP_ID
  //   wrangler secret put GITHUB_APP_PRIVATE_KEY
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;

  // GitHub App slug for constructing the install URL. Set with:
  //   wrangler secret put GITHUB_APP_SLUG
  GITHUB_APP_SLUG?: string;

  // URL to the GitHub App installation settings page. Shown on the
  // dashboard Integrations tab as the "Manage" link for GitHub.
  GITHUB_APP_SETTINGS_URL?: string;

  // Webhook signing secret for the Symphony GitHub App. A GitHub App
  // has one App-level webhook URL (`POST /webhook/github`) shared by
  // every installation, so signatures are verified against this
  // single secret. Must match the secret set on the App's webhook
  // config. Set with: wrangler secret put GITHUB_APP_WEBHOOK_SECRET.
  // When unset, /webhook/github returns 503.
  GITHUB_APP_WEBHOOK_SECRET?: string;

  // Master KEK (base64-encoded AES-256 key) for envelope encryption
  // of per-org credentials in the org_credentials table. Set with:
  //   wrangler secret put CREDENTIAL_KEK
  CREDENTIAL_KEK?: string;

  // ── Better Auth ────────────────────────────────────────────────
  // Random 32+ char string used to sign session cookies and CSRF
  // tokens. Set with: wrangler secret put BETTER_AUTH_SECRET.
  BETTER_AUTH_SECRET?: string;

  // GitHub OAuth for user login (separate from the Symphony GitHub
  // App used for PRs). Register a GitHub OAuth App with callback
  // `${URL}/api/auth/callback/github`. Set with:
  //   wrangler secret put GITHUB_CLIENT_ID
  //   wrangler secret put GITHUB_CLIENT_SECRET
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

// Re-export the Workflow class so wrangler's class_name resolution finds
// it from this module (the entry pointed at by `main`).
export { SessionRunner } from "./workflows/session-runner";

export function buildApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/", (c) =>
    c.json({
      ok: true,
      service: "linear-agent",
      hint: "GET /oauth/authorize to install; POST /webhook for Linear deliveries.",
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  // Better Auth — sign-in, sign-up, social, organization, session.
  // Mount before the dashboard routes so /api/auth/* is owned by it.
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const auth = createAuth(
      c.env,
      (c.req.raw as { cf?: IncomingRequestCfProperties }).cf,
      c.env.URL,
    );
    try {
      return await auth.handler(c.req.raw);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const stack = e instanceof Error ? (e.stack ?? "") : "";
      console.error("better_auth_error", c.req.method, new URL(c.req.url).pathname, msg, "\n", stack);
      return new Response(
        JSON.stringify({ error: "internal_error", message: msg }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  });

  app.route("/", buildApiV1Router());
  app.route("/", buildOpenApiRouter());
  app.route("/", buildMcpRouter());
  app.route("/", buildDashboardApiRouter());
  app.route("/", buildDashboardRouter());
  app.route("/", buildOAuthRouter());
  app.route("/", buildWebhookRouter());
  app.route("/", buildAdminRouter());
  app.route("/", buildGitHubRouter());
  app.route("/", buildInternalRouter());

  return app;
}

const app = buildApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await app.fetch(request, env, ctx);
    } catch (e) {
      // Outer net for any uncaught exception that escapes Hono's own error
      // handler (the "Illegal invocation" we kept seeing was masking the
      // real cause). Surface name+message+stack as a 500 body so Linear's
      // webhook delivery log shows the actual fault, not Workers' canned
      // error page.
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const stack = e instanceof Error ? e.stack ?? "" : "";
      console.error("outer_fetch_error", msg, "\n", stack);
      return new Response(
        JSON.stringify({ error: "outer_fetch_error", message: msg, stack }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },

  // Cron-driven zombie session reconciliation. Configured in
  // wrangler.jsonc under `triggers.crons`. Runs `*/5 * * * *` —
  // catches sessions that SessionRunner's in-band cleanup couldn't
  // close out (D1 outage during the catch block, force-terminated
  // instances, etc.). See src/lib/reconciler.ts for the heuristic.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await reconcileZombieSessions(env);
          if (result.scanned > 0) {
            console.log(
              "reconciler_tick",
              JSON.stringify(result),
            );
          }
        } catch (e) {
          console.error(
            "reconciler_failed",
            e instanceof Error ? e.message : String(e),
          );
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
