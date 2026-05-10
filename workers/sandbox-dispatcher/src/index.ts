import { Hono } from "hono";
import { proxyToSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";

import { buildAuthRouter } from "./auth";
import { hmacMiddleware, type HmacEnv } from "./hmac";
import { buildRunRouter } from "./run";

// Re-export the Sandbox Durable Object class so the Worker runtime can find
// it for the binding declared in wrangler.jsonc. `@cloudflare/sandbox`
// provides the canonical implementation; we don't subclass it.
export { Sandbox } from "@cloudflare/sandbox";

export interface Env extends HmacEnv {
  Sandbox: DurableObjectNamespace<SandboxType>;
  BACKUP_BUCKET: R2Bucket;
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  // Set to "true" in the dev env so createBackup uses the bound R2
  // namespace directly (no presigned URLs in local development).
  USE_LOCAL_BACKUP_BUCKET?: string;
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

  app.route("/", buildAuthRouter());
  app.route("/", buildRunRouter());

  return app;
}

const app = buildApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Cloudflare Sandbox's preview URLs (returned by `sandbox.exposePort()`)
    // route back through the worker that owns the DO namespace. proxyToSandbox
    // handles those subdomain requests transparently — for non-preview URLs
    // it returns null and we fall through to our own router.
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
