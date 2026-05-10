import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import type { DirectoryBackup } from "@cloudflare/sandbox";

import type { Env } from "./index";
import { AuthBackupStore, type AuthBackupRecord } from "./storage";
import {
  SNAPSHOT_DIR,
  SNAPSHOT_TTL_SECONDS,
  safeDestroy,
  sanitizeScopeForId,
  useLocalBackupBucket,
} from "./sandbox-helpers";

/**
 * Phase 6: cron snapshot refresh.
 *
 * The R2 bucket has a lifecycle rule that GCs anything under `backups/`
 * after 14 days (see `docs/cloudflare_sandbox_integration.md`). Without
 * intervention, an active scope's snapshot would silently disappear after
 * two weeks of inactivity, breaking every subsequent `/run` and forcing
 * the operator to redo `claude login` / `codex auth login` / `gh auth
 * login`.
 *
 * This module rewrites still-active snapshots before they age out:
 *
 *   1. List every row in `auth_backups` whose `refreshed_at` is older
 *      than `REFRESH_AGE_SECONDS` (default 5 days).
 *   2. For each, spin up a throwaway sandbox (`refresh-<sanitized-scope>`),
 *      `restoreBackup(handle)` to load the existing state, and
 *      immediately `createBackup(...)` to write a fresh R2 object with
 *      today's timestamp.
 *   3. Atomically swap the D1 row's handle + `refreshed_at` to the new
 *      backup id.
 *   4. `safeDestroy` the sandbox.
 *
 * The lifecycle rule then GCs the now-orphaned old R2 object on its
 * normal 14-day cadence. The active scope stays "young" indefinitely.
 *
 * Two trigger paths:
 *
 *   - `scheduled()` in `index.ts` calls `refreshStaleSnapshots(env, now)`
 *     on the cron declared in `wrangler.jsonc` (`triggers.crons`).
 *   - `POST /auth/refresh` (HMAC-signed) lets ops trigger one manually
 *     for testing or recovery. Optional `{ force: true }` ignores the
 *     age threshold and refreshes every scope.
 *
 * Failures per-scope are isolated — one broken scope doesn't poison
 * the rest of the batch. Outcomes are returned (and logged from the
 * scheduled handler) so failures are visible in `wrangler tail`.
 */

// Refresh snapshots whose `refreshed_at` is older than this many seconds.
// Tuned for the 14-day R2 lifecycle rule with a comfortable safety margin
// (5 days = 9 days of buffer before GC). Override per-call via
// `refreshStaleSnapshots(env, now, { ageSeconds })` if needed.
export const DEFAULT_REFRESH_AGE_SECONDS = 5 * 24 * 60 * 60;

export interface RefreshOptions {
  // Treat a row as stale if `refreshed_at` is older than (now - ageSeconds).
  ageSeconds?: number;
  // Ignore the age threshold and refresh every scope. Used by ops triggers
  // and tests; the cron always uses age-based filtering.
  force?: boolean;
}

export type RefreshOutcome = "refreshed" | "skipped" | "failed";

export interface RefreshResult {
  scope: string;
  outcome: RefreshOutcome;
  age_seconds_at_refresh: number;
  new_backup_id?: string;
  old_backup_id?: string;
  error_message?: string;
}

export function refreshSandboxId(scope: string): string {
  // Tag distinct from `bootstrap-` and `run-` so the refresh job can't
  // collide with an in-flight bootstrap PTY or per-issue /run sandbox
  // for the same scope.
  return `refresh-${sanitizeScopeForId(scope)}`;
}

/**
 * Iterate every snapshot row, refresh the stale ones, and return per-scope
 * outcomes. Always resolves; per-scope failures are captured in the result
 * objects rather than thrown.
 */
export async function refreshStaleSnapshots(
  env: Env,
  now: number,
  opts: RefreshOptions = {},
): Promise<RefreshResult[]> {
  const ageSeconds = opts.ageSeconds ?? DEFAULT_REFRESH_AGE_SECONDS;
  const threshold = now - ageSeconds;
  const force = opts.force === true;

  const store = new AuthBackupStore(env.DB);
  const records = await store.list();

  const results: RefreshResult[] = [];
  for (const record of records) {
    const lastRefreshed = record.refreshed_at ?? record.created_at;
    const age = now - lastRefreshed;
    const isStale = lastRefreshed < threshold;

    if (!force && !isStale) {
      results.push({
        scope: record.scope,
        outcome: "skipped",
        age_seconds_at_refresh: age,
        old_backup_id: record.handle.id,
      });
      continue;
    }

    try {
      const fresh = await refreshSnapshot(env, record);
      await store.upsert(record.scope, fresh, now);
      results.push({
        scope: record.scope,
        outcome: "refreshed",
        age_seconds_at_refresh: age,
        old_backup_id: record.handle.id,
        new_backup_id: fresh.id,
      });
    } catch (err) {
      results.push({
        scope: record.scope,
        outcome: "failed",
        age_seconds_at_refresh: age,
        old_backup_id: record.handle.id,
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function refreshSnapshot(
  env: Env,
  record: AuthBackupRecord,
): Promise<DirectoryBackup> {
  const sandboxId = refreshSandboxId(record.scope);

  // Defensive teardown of any prior refresh sandbox for this scope before
  // we start. If a previous run aborted mid-flight (e.g. CF restarted the
  // DO), residual state on the same id would leak in.
  await safeDestroy(getSandbox(env.Sandbox, sandboxId));

  const sandbox = getSandbox(env.Sandbox, sandboxId);
  try {
    await sandbox.restoreBackup(record.handle);
    const handle = await sandbox.createBackup({
      dir: SNAPSHOT_DIR,
      name: `auth-${record.scope}-refresh-${Date.now()}`,
      ttl: SNAPSHOT_TTL_SECONDS,
      localBucket: useLocalBackupBucket(env),
    });
    return handle;
  } finally {
    await safeDestroy(sandbox);
  }
}

/**
 * `POST /auth/refresh` — manual trigger for the same logic the cron runs.
 * HMAC-signed (mounted under the global hmacMiddleware in `index.ts`).
 *
 * Body (all optional):
 *   { age_seconds?: number, force?: boolean, scope?: string }
 *
 * If `scope` is provided, only that single scope is considered (still
 * subject to age/force). Otherwise every scope is checked.
 */
export function buildRefreshRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/auth/refresh", async (c) => {
    const body = await readJsonBody<{
      age_seconds?: unknown;
      force?: unknown;
      scope?: unknown;
    }>(c.req.raw);

    const opts: RefreshOptions = {};
    if (typeof body.age_seconds === "number" && body.age_seconds >= 0) {
      opts.ageSeconds = Math.floor(body.age_seconds);
    }
    if (body.force === true) {
      opts.force = true;
    }

    const scopeFilter = parseOptionalScope(body.scope);
    const now = Math.floor(Date.now() / 1000);

    if (scopeFilter !== undefined) {
      // Single-scope path: load just that record and run through the same
      // staleness logic as the bulk path.
      const store = new AuthBackupStore(c.env.DB);
      const record = await store.get(scopeFilter);
      if (!record) {
        return c.json({ error: "missing_auth_backup", scope: scopeFilter }, 412);
      }
      const results = await refreshStaleSnapshotsForRecords(
        c.env,
        [record],
        now,
        opts,
      );
      return c.json({
        ok: true,
        now,
        results,
      });
    }

    const results = await refreshStaleSnapshots(c.env, now, opts);
    return c.json({
      ok: true,
      now,
      checked: results.length,
      refreshed: results.filter((r) => r.outcome === "refreshed").length,
      skipped: results.filter((r) => r.outcome === "skipped").length,
      failed: results.filter((r) => r.outcome === "failed").length,
      results,
    });
  });

  return app;
}

// Internal: same logic as refreshStaleSnapshots but operates on a
// pre-fetched record list. Lets `/auth/refresh?scope=X` reuse the per-row
// logic without a redundant SELECT.
async function refreshStaleSnapshotsForRecords(
  env: Env,
  records: AuthBackupRecord[],
  now: number,
  opts: RefreshOptions,
): Promise<RefreshResult[]> {
  const ageSeconds = opts.ageSeconds ?? DEFAULT_REFRESH_AGE_SECONDS;
  const threshold = now - ageSeconds;
  const force = opts.force === true;
  const store = new AuthBackupStore(env.DB);
  const out: RefreshResult[] = [];

  for (const record of records) {
    const lastRefreshed = record.refreshed_at ?? record.created_at;
    const age = now - lastRefreshed;
    const isStale = lastRefreshed < threshold;
    if (!force && !isStale) {
      out.push({
        scope: record.scope,
        outcome: "skipped",
        age_seconds_at_refresh: age,
        old_backup_id: record.handle.id,
      });
      continue;
    }
    try {
      const fresh = await refreshSnapshot(env, record);
      await store.upsert(record.scope, fresh, now);
      out.push({
        scope: record.scope,
        outcome: "refreshed",
        age_seconds_at_refresh: age,
        old_backup_id: record.handle.id,
        new_backup_id: fresh.id,
      });
    } catch (err) {
      out.push({
        scope: record.scope,
        outcome: "failed",
        age_seconds_at_refresh: age,
        old_backup_id: record.handle.id,
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

function parseOptionalScope(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^[a-zA-Z0-9._:@-]+$/.test(trimmed)) return undefined;
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
