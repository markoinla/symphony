import { Hono } from "hono";

import { hmacMiddleware, type HmacEnv } from "./hmac";

// Re-export the Sandbox Durable Object class so the Worker runtime can find
// it for the binding declared in wrangler.jsonc. `@cloudflare/sandbox`
// provides the canonical implementation; we don't subclass it in Phase 2.
export { Sandbox } from "@cloudflare/sandbox";

export interface Env extends HmacEnv {
  Sandbox: DurableObjectNamespace;
  BACKUP_BUCKET: R2Bucket;
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export const SANDBOX_INSTANCE_TYPE = "standard-2" as const;

export function buildApp() {
  const app = new Hono<{ Bindings: Env }>();

  // HMAC verification runs first; `/health` is exempted inside the middleware
  // so it doubles as a liveness probe without sharing the dispatcher secret.
  app.use("*", hmacMiddleware);

  app.get("/health", (c) =>
    c.json({
      ok: true,
      sandbox_class: SANDBOX_INSTANCE_TYPE,
    }),
  );

  return app;
}

const app = buildApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
