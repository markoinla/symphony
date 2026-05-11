import type { DirectoryBackup } from "@cloudflare/sandbox";

/**
 * D1-backed repository for the `auth_backups` table.
 *
 * Each row maps a snapshot scope (e.g. `"alice"` or `"alice:proj-42"`)
 * to a serialized `DirectoryBackup` handle returned by
 * `sandbox.createBackup({ ... })`. The handle is what `restoreBackup()`
 * needs to repopulate `/home/node` when starting a per-issue sandbox.
 *
 * `created_at` and `refreshed_at` are unix epoch seconds. `refreshed_at`
 * is initialized to the same value as `created_at` and bumped by Phase 6's
 * cron snapshot refresh.
 */

export interface AuthBackupRecord {
  scope: string;
  handle: DirectoryBackup;
  created_at: number;
  refreshed_at: number | null;
}

export interface AuthBackupSummary {
  scope: string;
  backup_id: string;
  created_at: number;
  refreshed_at: number | null;
}

export class AuthBackupStore {
  constructor(private readonly db: D1Database) {}

  async upsert(scope: string, handle: DirectoryBackup, now: number): Promise<void> {
    const json = JSON.stringify(handle);
    await this.db
      .prepare(
        `INSERT INTO auth_backups (scope, handle, created_at, refreshed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           handle = excluded.handle,
           created_at = excluded.created_at,
           refreshed_at = excluded.refreshed_at`,
      )
      .bind(scope, json, now, now)
      .run();
  }

  async get(scope: string): Promise<AuthBackupRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT scope, handle, created_at, refreshed_at
         FROM auth_backups WHERE scope = ?`,
      )
      .bind(scope)
      .first<{
        scope: string;
        handle: string;
        created_at: number;
        refreshed_at: number | null;
      }>();

    if (!row) return null;

    return {
      scope: row.scope,
      handle: parseHandle(row.handle),
      created_at: row.created_at,
      refreshed_at: row.refreshed_at,
    };
  }

  async getSummary(scope: string): Promise<AuthBackupSummary | null> {
    const record = await this.get(scope);
    if (!record) return null;
    return {
      scope: record.scope,
      backup_id: record.handle.id,
      created_at: record.created_at,
      refreshed_at: record.refreshed_at,
    };
  }

  async delete(scope: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM auth_backups WHERE scope = ?")
      .bind(scope)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async list(): Promise<AuthBackupRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT scope, handle, created_at, refreshed_at
         FROM auth_backups ORDER BY scope`,
      )
      .all<{
        scope: string;
        handle: string;
        created_at: number;
        refreshed_at: number | null;
      }>();

    return result.results.map((row) => ({
      scope: row.scope,
      handle: parseHandle(row.handle),
      created_at: row.created_at,
      refreshed_at: row.refreshed_at,
    }));
  }

  async touchRefreshed(scope: string, refreshedAt: number): Promise<void> {
    await this.db
      .prepare("UPDATE auth_backups SET refreshed_at = ? WHERE scope = ?")
      .bind(refreshedAt, scope)
      .run();
  }
}

export interface BaselineRecord {
  engine: string;
  handle: DirectoryBackup;
  version: string | null;
  created_at: number;
  refreshed_at: number | null;
}

export interface BaselineSummary {
  engine: string;
  baseline_id: string;
  version: string | null;
  created_at: number;
  refreshed_at: number | null;
}

export class BaselineStore {
  constructor(private readonly db: D1Database) {}

  async upsert(
    engine: string,
    handle: DirectoryBackup,
    version: string | null,
    now: number,
  ): Promise<void> {
    const json = JSON.stringify(handle);
    await this.db
      .prepare(
        `INSERT INTO engine_baselines (engine, handle, version, created_at, refreshed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(engine) DO UPDATE SET
           handle = excluded.handle,
           version = excluded.version,
           created_at = excluded.created_at,
           refreshed_at = excluded.refreshed_at`,
      )
      .bind(engine, json, version, now, now)
      .run();
  }

  async get(engine: string): Promise<BaselineRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT engine, handle, version, created_at, refreshed_at
         FROM engine_baselines WHERE engine = ?`,
      )
      .bind(engine)
      .first<{
        engine: string;
        handle: string;
        version: string | null;
        created_at: number;
        refreshed_at: number | null;
      }>();

    if (!row) return null;

    return {
      engine: row.engine,
      handle: parseHandle(row.handle),
      version: row.version,
      created_at: row.created_at,
      refreshed_at: row.refreshed_at,
    };
  }

  async getSummary(engine: string): Promise<BaselineSummary | null> {
    const record = await this.get(engine);
    if (!record) return null;
    return {
      engine: record.engine,
      baseline_id: record.handle.id,
      version: record.version,
      created_at: record.created_at,
      refreshed_at: record.refreshed_at,
    };
  }

  async delete(engine: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM engine_baselines WHERE engine = ?")
      .bind(engine)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async list(): Promise<BaselineRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT engine, handle, version, created_at, refreshed_at
         FROM engine_baselines ORDER BY engine`,
      )
      .all<{
        engine: string;
        handle: string;
        version: string | null;
        created_at: number;
        refreshed_at: number | null;
      }>();

    return result.results.map((row) => ({
      engine: row.engine,
      handle: parseHandle(row.handle),
      version: row.version,
      created_at: row.created_at,
      refreshed_at: row.refreshed_at,
    }));
  }

  async touchRefreshed(engine: string, refreshedAt: number): Promise<void> {
    await this.db
      .prepare("UPDATE engine_baselines SET refreshed_at = ? WHERE engine = ?")
      .bind(refreshedAt, engine)
      .run();
  }
}

function parseHandle(raw: string): DirectoryBackup {
  const parsed = JSON.parse(raw) as Partial<DirectoryBackup>;
  if (typeof parsed.id !== "string" || typeof parsed.dir !== "string") {
    throw new Error(`handle is not a valid DirectoryBackup: ${raw}`);
  }
  return parsed as DirectoryBackup;
}
