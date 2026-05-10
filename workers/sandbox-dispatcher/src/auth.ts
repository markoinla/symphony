import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";

import type { Env } from "./index";
import { AuthBackupStore } from "./storage";

/**
 * Auth bootstrap + snapshot routes.
 *
 * Manual flow:
 *   1. Operator POSTs `/auth/bootstrap { scope }`. The dispatcher boots a
 *      bootstrap sandbox tagged `bootstrap:<scope>`, optionally restores
 *      any prior snapshot for that scope, starts ttyd on port 7681, and
 *      returns a one-time PTY URL.
 *   2. Operator opens the PTY URL in a browser, runs `claude login`,
 *      `codex auth login`, `gh auth login` interactively.
 *   3. Operator POSTs `/auth/snapshot { scope }`. The dispatcher calls
 *      `sandbox.createBackup({ dir: "/home/node", ... })`, persists the
 *      returned `DirectoryBackup` handle in D1, then destroys the sandbox.
 *
 * `GET /auth/snapshot?scope=...` reports whether a snapshot exists (no
 * handle exposed). `DELETE /auth/snapshot { scope }` removes the row;
 * the underlying R2 object is left to expire on the configured TTL.
 *
 * `scope` is opaque — Symphony chooses the granularity. Today we expect
 * `<user_id>`; per-project (`<user_id>:<project_id>`) is supported by
 * passing a different string.
 */

// PTY sessions auto-expire on the dispatcher side after this many ms; the
// caller is expected to either snapshot before then or call /auth/snapshot
// (which destroys the sandbox) explicitly.
const BOOTSTRAP_TTL_MS = 30 * 60 * 1000;

// Snapshot R2 retention (seconds). 7 days is enough cushion for the cron
// refresh job in Phase 6 to keep credentials fresh; the cron can also call
// createBackup again to extend the TTL.
const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

const SNAPSHOT_DIR = "/home/node";

// Port the Dockerfile installs ttyd on. The bootstrap PTY exposes this
// port via Cloudflare Sandbox's preview-URL mechanism.
const TTYD_PORT = 7681;

interface BootstrapBody {
  scope?: unknown;
}

interface SnapshotBody {
  scope?: unknown;
}

export function buildAuthRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/auth/bootstrap", async (c) => {
    const body = await readJsonBody<BootstrapBody>(c.req.raw);
    const scope = parseScope(body.scope);
    if (!scope) {
      return c.json({ error: "invalid_scope" }, 400);
    }

    const sandboxId = bootstrapSandboxId(scope);
    const sandbox = getSandbox(c.env.Sandbox, sandboxId);

    // If there's a prior snapshot for this scope, restore it first so the
    // operator picks up where they left off (e.g. extending one CLI's
    // login without re-doing the others).
    const store = new AuthBackupStore(c.env.DB);
    const prior = await store.get(scope);
    if (prior) {
      await sandbox.restoreBackup(prior.handle);
    }

    // Start ttyd as a background process so it survives this request.
    // `-W` enables write access from the browser (required for typing).
    // `-t titleFixed` makes the page title deterministic so the operator
    // can recognize multiple bootstrap tabs.
    await sandbox.startProcess(
      `ttyd -p ${TTYD_PORT} -W -t titleFixed=symphony-bootstrap-${scope} bash -l`,
      {
        autoCleanup: false,
      },
    );

    const hostname = new URL(c.req.url).host;
    const exposed = await sandbox.exposePort(TTYD_PORT, { hostname });

    return c.json({
      pty_url: exposed.url,
      sandbox_id: sandboxId,
      scope,
      had_prior_snapshot: prior !== null,
      expires_at: new Date(Date.now() + BOOTSTRAP_TTL_MS).toISOString(),
    });
  });

  app.post("/auth/snapshot", async (c) => {
    const body = await readJsonBody<SnapshotBody>(c.req.raw);
    const scope = parseScope(body.scope);
    if (!scope) {
      return c.json({ error: "invalid_scope" }, 400);
    }

    const sandboxId = bootstrapSandboxId(scope);
    const sandbox = getSandbox(c.env.Sandbox, sandboxId);

    let handle;
    try {
      handle = await sandbox.createBackup({
        dir: SNAPSHOT_DIR,
        name: `auth-${scope}-${Date.now()}`,
        ttl: SNAPSHOT_TTL_SECONDS,
        // Local R2 binding mode is required when running under wrangler dev
        // (no presigned URL infrastructure). In production this should be
        // false (the default) so the container streams directly to R2.
        localBucket: useLocalBackupBucket(c.env),
      });
    } catch (err) {
      // Tear the sandbox down even if the backup failed — we don't want
      // long-lived containers leaking on the operator's account.
      await safeDestroy(sandbox);
      throw err;
    }

    const now = Math.floor(Date.now() / 1000);
    const store = new AuthBackupStore(c.env.DB);
    await store.upsert(scope, handle, now);

    await safeDestroy(sandbox);

    return c.json({
      ok: true,
      backup_id: handle.id,
      scope,
      created_at: now,
    });
  });

  app.get("/auth/snapshot", async (c) => {
    const scope = parseScope(c.req.query("scope"));
    if (!scope) {
      return c.json({ error: "invalid_scope" }, 400);
    }

    const store = new AuthBackupStore(c.env.DB);
    const summary = await store.getSummary(scope);
    if (!summary) {
      return c.json({ exists: false, scope }, 404);
    }

    return c.json({
      exists: true,
      ...summary,
    });
  });

  app.delete("/auth/snapshot", async (c) => {
    const body = await readJsonBody<SnapshotBody>(c.req.raw);
    const scope = parseScope(body.scope);
    if (!scope) {
      return c.json({ error: "invalid_scope" }, 400);
    }

    const store = new AuthBackupStore(c.env.DB);
    const removed = await store.delete(scope);
    return c.json({ ok: true, scope, removed });
  });

  return app;
}

export function bootstrapSandboxId(scope: string): string {
  return `bootstrap:${scope}`;
}

function parseScope(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Reject anything that would let a caller smuggle path or
  // sandbox-id metacharacters into our derived ids.
  if (!/^[a-zA-Z0-9._:@-]+$/.test(trimmed)) return null;
  return trimmed;
}

async function readJsonBody<T>(req: Request): Promise<T> {
  if (req.method === "GET" || req.method === "HEAD") return {} as T;
  const text = await req.clone().text();
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

function useLocalBackupBucket(env: Env): boolean {
  // Operators opt into local-bucket mode by setting USE_LOCAL_BACKUP_BUCKET
  // to "true" in the dev env wrangler.jsonc (or via `wrangler secret put`).
  return env.USE_LOCAL_BACKUP_BUCKET === "true";
}

async function safeDestroy(sandbox: { destroy(): Promise<void> }): Promise<void> {
  try {
    await sandbox.destroy();
  } catch {
    // Sandbox may already be torn down or unreachable; we don't want a
    // cleanup failure to mask the real (or successful) result.
  }
}
