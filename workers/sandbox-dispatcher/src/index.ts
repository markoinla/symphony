import { Hono } from "hono";
import { proxyToSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";

import { buildBaselineRouter } from "./baselines";
import { buildBaselineEditRouter } from "./baseline-edit";
import { hmacMiddleware, type HmacEnv } from "./hmac";
import { buildRunRouter } from "./run";
import { buildRefreshRouter, refreshStaleBaselines } from "./refresh";

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
  // GitHub PAT (org-wide for item 4 of SYM-267) used to push the
  // agent's commits after a successful engine run. Set with
  // `wrangler secret put DISPATCH_GITHUB_TOKEN`. When unset, /run
  // skips the push step and the linear-agent worker won't see a
  // `branch` field in the result event.
  DISPATCH_GITHUB_TOKEN?: string;
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

  app.route("/", buildBaselineRouter());
  app.route("/", buildBaselineEditRouter());
  app.route("/", buildRunRouter());
  app.route("/", buildRefreshRouter());

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

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil(
      (async () => {
        try {
          const results = await refreshStaleBaselines(env, now);
          console.log(
            JSON.stringify({
              event: "baseline.refresh.complete",
              now,
              checked: results.length,
              refreshed: results.filter((r) => r.outcome === "refreshed").length,
              skipped: results.filter((r) => r.outcome === "skipped").length,
              failed: results.filter((r) => r.outcome === "failed").length,
              results,
            }),
          );
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "baseline.refresh.error",
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err;
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
