import type { DirectoryBackup } from "@cloudflare/sandbox";

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
