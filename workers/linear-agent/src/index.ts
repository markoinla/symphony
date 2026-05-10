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
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
