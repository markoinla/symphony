import { Hono } from "hono";

import { buildAdminRouter } from "./routes/admin";
import { buildOAuthRouter } from "./routes/oauth";
import { buildWebhookRouter } from "./routes/webhook";

export interface Env {
  // KV namespace storing OAuth state nonces and webhook delivery
  // dedupe markers. As of item 3, the install access token lives in
  // D1 (`installations.access_token`), not here.
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
  // PROJECT_MAPPINGS_JSON stays as a fallback during the D1 cutover
  // so deploys without a seeded DB keep working.
  DEFAULT_SCOPE: string;
  DEFAULT_MODEL: string;
  DEFAULT_ENGINE: string;
  PROJECT_MAPPINGS_JSON: string;
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
  GITHUB_TOKEN?: string;
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

  app.route("/", buildOAuthRouter());
  app.route("/", buildWebhookRouter());
  app.route("/", buildAdminRouter());

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
} satisfies ExportedHandler<Env>;
