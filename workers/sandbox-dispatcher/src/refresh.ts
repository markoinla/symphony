import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import type { DirectoryBackup } from "@cloudflare/sandbox";

import type { Env } from "./index";
import { BaselineStore, type BaselineRecord } from "./storage";
import {
  SNAPSHOT_DIR,
  SNAPSHOT_TTL_SECONDS,
  safeDestroy,
  useLocalBackupBucket,
} from "./sandbox-helpers";

/**
 * Baseline snapshot refresh.
 *
 * The R2 bucket has a lifecycle rule that GCs anything under `backups/`
 * after 14 days. Without intervention, a baseline snapshot would silently
 * expire, breaking every subsequent `/run` for that engine.
 *
 * This module rewrites baseline snapshots before they age out:
 *
 *   1. List every row in `engine_baselines` whose `refreshed_at` is older
 *      than `REFRESH_AGE_SECONDS` (default 5 days).
 *   2. For each, spin up a throwaway sandbox (`refresh-baseline-<engine>`),
 *      `restoreBackup(handle)` to load the existing state, and
 *      immediately `createBackup(...)` to write a fresh R2 object.
 *   3. Atomically swap the D1 row's handle + `refreshed_at`.
 *   4. `safeDestroy` the sandbox.
 *
 * Two trigger paths:
 *   - `scheduled()` in `index.ts` calls `refreshStaleBaselines(env, now)`
 *     on the cron declared in `wrangler.jsonc`.
 *   - `POST /baselines/refresh` (HMAC-signed) lets ops trigger manually.
 */

export const DEFAULT_REFRESH_AGE_SECONDS = 5 * 24 * 60 * 60;

export interface RefreshOptions {
  ageSeconds?: number;
  force?: boolean;
}

export type RefreshOutcome = "refreshed" | "skipped" | "failed";

export interface RefreshResult {
  engine: string;
  outcome: RefreshOutcome;
  age_seconds_at_refresh: number;
  new_backup_id?: string;
  old_backup_id?: string;
  error_message?: string;
}

export async function refreshStaleBaselines(
  env: Env,
  now: number,
  opts: RefreshOptions = {},
): Promise<RefreshResult[]> {
  const ageSeconds = opts.ageSeconds ?? DEFAULT_REFRESH_AGE_SECONDS;
  const threshold = now - ageSeconds;
  const force = opts.force === true;

  const store = new BaselineStore(env.DB);
  const records = await store.list();

  return refreshBaselineRecords(env, store, records, now, threshold, force);
}

async function refreshBaselineRecords(
  env: Env,
  store: BaselineStore,
  records: BaselineRecord[],
  now: number,
  threshold: number,
  force: boolean,
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];

  for (const record of records) {
    const lastRefreshed = record.refreshed_at ?? record.created_at;
    const age = now - lastRefreshed;
    const isStale = lastRefreshed < threshold;

    if (!force && !isStale) {
      results.push({
        engine: record.engine,
        outcome: "skipped",
        age_seconds_at_refresh: age,
        old_backup_id: record.handle.id,
      });
      continue;
    }

    try {
      const fresh = await refreshBaseline(env, record);
      await store.upsert(record.engine, fresh, record.version, now);
      results.push({
        engine: record.engine,
        outcome: "refreshed",
        age_seconds_at_refresh: age,
        old_backup_id: record.handle.id,
        new_backup_id: fresh.id,
      });
    } catch (err) {
      results.push({
        engine: record.engine,
        outcome: "failed",
        age_seconds_at_refresh: age,
        old_backup_id: record.handle.id,
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function refreshBaseline(
  env: Env,
  record: BaselineRecord,
): Promise<DirectoryBackup> {
  const sandboxId = `refresh-baseline-${record.engine}`;

  await safeDestroy(getSandbox(env.Sandbox, sandboxId));

  const sandbox = getSandbox(env.Sandbox, sandboxId);
  try {
    await sandbox.restoreBackup(record.handle);
    const handle = await sandbox.createBackup({
      dir: SNAPSHOT_DIR,
      name: `baseline-${record.engine}-refresh-${Date.now()}`,
      ttl: SNAPSHOT_TTL_SECONDS,
      localBucket: useLocalBackupBucket(env),
    });
    return handle;
  } finally {
    await safeDestroy(sandbox);
  }
}

export function buildRefreshRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/baselines/refresh", async (c) => {
    const body = await readJsonBody<{
      age_seconds?: unknown;
      force?: unknown;
      engine?: unknown;
    }>(c.req.raw);

    const opts: RefreshOptions = {};
    if (typeof body.age_seconds === "number" && body.age_seconds >= 0) {
      opts.ageSeconds = Math.floor(body.age_seconds);
    }
    if (body.force === true) {
      opts.force = true;
    }

    const engineFilter = parseOptionalEngine(body.engine);
    const now = Math.floor(Date.now() / 1000);
    const ageSeconds = opts.ageSeconds ?? DEFAULT_REFRESH_AGE_SECONDS;
    const threshold = now - ageSeconds;
    const force = opts.force === true;

    if (engineFilter !== undefined) {
      const store = new BaselineStore(c.env.DB);
      const record = await store.get(engineFilter);
      if (!record) {
        return c.json({ error: "missing_baseline", engine: engineFilter }, 412);
      }
      const results = await refreshBaselineRecords(
        c.env,
        store,
        [record],
        now,
        threshold,
        force,
      );
      return c.json({ ok: true, now, results });
    }

    const results = await refreshStaleBaselines(c.env, now, opts);
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

function parseOptionalEngine(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
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
