import { Hono } from "hono";

import { buildOAuthRouter } from "./routes/oauth";
import { buildWebhookRouter } from "./routes/webhook";

export interface Env {
  // KV namespace storing the agent's `actor=app` access token, OAuth
  // state nonce, and webhook delivery dedupe markers.
  LINEAR_TOKENS: KVNamespace;

  // Linear OAuth + webhook secrets
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  LINEAR_WEBHOOK_SECRET: string;

  // Sandbox dispatcher
  DISPATCHER_URL: string;
  DISPATCH_HMAC_SECRET: string;

  // Public origin of this worker (used to build OAuth callback URL)
  URL: string;

  // Run defaults — temporary stand-ins for D1 project rows.
  DEFAULT_SCOPE: string;
  DEFAULT_MODEL: string;
  DEFAULT_ENGINE: string;
  PROJECT_MAPPINGS_JSON: string;
}

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
