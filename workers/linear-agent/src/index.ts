import { Hono } from "hono";

import { buildAdminRouter } from "./routes/admin";
import { buildDashboardApiRouter } from "./routes/dashboard-api";
import { buildGitHubInstallRouter } from "./routes/github-install";
import { buildOAuthRouter } from "./routes/oauth";
import { buildWebhookRouter } from "./routes/webhook";
import { readSessionFromRequest } from "./lib/session-cookie";

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
  // SYM-268: retired in favor of `github_app_installation_id` per-org
  // + `mintInstallationToken`. Kept as a transitional fallback so
  // single-org installs keep working while orgs install the App.
  GITHUB_TOKEN?: string;

  // SYM-268 envelope encryption: master KEK used to wrap per-org
  // DEKs in the `org_credentials` table. Bump to KEK_V2 when
  // rotating. See `src/lib/crypto.ts`. 64-char hex string (32 bytes).
  KEK_V1?: string;

  // SYM-268 dashboard session cookies. Random 32+ byte string;
  // signing key for `sym_dash_session`. Rotating this is a global
  // session reset.
  DASHBOARD_COOKIE_SECRET?: string;

  // SYM-268 GitHub App — replaces the org-wide `GITHUB_TOKEN` PAT.
  // `GITHUB_APP_ID` is the numeric App id; `GITHUB_APP_PRIVATE_KEY`
  // is an RS256 PEM (PKCS#8 or PKCS#1) used to sign installation
  // JWTs; `GITHUB_APP_INSTALL_URL` is the public install URL,
  // e.g. https://github.com/apps/<slug>/installations/new.
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALL_URL?: string;

  // SYM-268 (Phase 7) static assets binding for the dashboard SPA.
  // Populated by wrangler's `assets` directive pointing at
  // dashboard/dist. When unset, `/dashboard/*` returns 404 — the
  // OAuth/install flows still work but there's no UI to land on.
  ASSETS?: Fetcher;
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
  app.route("/", buildGitHubInstallRouter());
  app.route("/", buildDashboardApiRouter());

  // Dashboard SPA. Auth-gated at the entry point so a logged-out user
  // bounces straight into Linear instead of seeing an empty shell.
  //
  // Path layout:
  //   /dashboard          → index.html (auth-gated)
  //   /dashboard/<...>    → static assets (CSS/JS bundles, history routes)
  //
  // Vite builds with `base: "/dashboard/"` so the HTML references
  // `/dashboard/assets/...`. The wrangler `assets` binding serves
  // from the root of `dashboard/dist` (no path prefix support), so we
  // strip `/dashboard` from the request before forwarding to ASSETS.
  // `not_found_handling: "single-page-application"` in wrangler.jsonc
  // makes ASSETS fall back to /index.html on unknown paths (for SPA
  // history routes).
  app.get("/dashboard", async (c) => {
    const session = await readSessionFromRequest(c.env, c.req.raw);
    if (!session) return c.redirect("/oauth/user/authorize");
    if (!c.env.ASSETS) return c.json({ error: "assets_unbound" }, 500);
    const url = new URL(c.req.url);
    // The assets binding 307s `/index.html` → `/` so we fetch `/`
    // directly. Returns the SPA shell with all asset paths
    // (`/dashboard/assets/...`) intact for the browser to fetch.
    url.pathname = "/";
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  });
  app.get("/dashboard/*", async (c) => {
    if (!c.env.ASSETS) return c.json({ error: "assets_unbound" }, 500);
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/dashboard/, "") || "/";
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  });

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
