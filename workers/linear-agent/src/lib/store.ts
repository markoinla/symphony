/**
 * D1-backed repository for the linear-agent worker.
 *
 * Three main tables (+ supporting tables):
 *   - `organizations` — one row per Linear workspace install (orgId, name, plan)
 *   - `installations` — actor=app OAuth token per org (org_id FK, access_token, refresh_token, scopes, status)
 *   - `projects`      — per-team config: repo URL, engine, model, max_turns
 *   - `users`         — dashboard logins with actor=user tokens
 *   - `org_credentials` — per-org encrypted secrets (BYO API keys)
 *   - `sessions`      — agent session records
 *   - `usage`         — aggregated billing data per org
 *
 * Migration: see `workers/linear-agent/migrations/0002_multi_tenant.sql`.
 *
 * Style note: column names are SQL-flavored (`org_id`,
 * `max_turns`); the typed records mirror them via `snake_case` so we
 * don't have to remember which mapping is which. Callers that prefer
 * camelCase wrap the read in their own adapter.
 */

export interface InstallationRecord {
  id: number;
  org_id: string;
  access_token: string;
  refresh_token: string | null;
  scopes: string;
  installed_by: string;
  status: string;
  installed_at: string;
  refreshed_at: string;
}

export interface ProjectRecord {
  team_id: string;
  repo_url: string;
  default_branch: string;
  engine: string;
  model: string | null;
  max_turns: number;
  updated_at: string;
}

export class InstallationStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Insert or create the installation token for an organization. The
   * caller passes the token Linear returned from the OAuth code
   * exchange. Multiple re-installs of the same org update the row.
   */
  async upsert(
    orgId: string,
    accessToken: string,
    refreshToken: string | null,
    scopes: string,
    installedBy: string,
    status: string = "active",
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO installations (org_id, access_token, refresh_token, scopes, installed_by, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           access_token  = excluded.access_token,
           refresh_token = excluded.refresh_token,
           scopes        = excluded.scopes,
           installed_by  = excluded.installed_by,
           status        = excluded.status,
           refreshed_at  = datetime('now')`,
      )
      .bind(orgId, accessToken, refreshToken, scopes, installedBy, status)
      .run();
  }

  async get(orgId: string): Promise<InstallationRecord | null> {
    return await this.db
      .prepare(
        `SELECT id, org_id, access_token, refresh_token, scopes, installed_by, status, installed_at, refreshed_at
         FROM installations WHERE org_id = ?`,
      )
      .bind(orgId)
      .first<InstallationRecord>();
  }

  /**
   * Single-org fallback for webhook deliveries that don't carry an
   * `orgId` field. If there's exactly one install, return it;
   * otherwise return null and force the caller to look up by org id.
   */
  async getOnlyInstallation(): Promise<InstallationRecord | null> {
    const result = await this.db
      .prepare(
        `SELECT id, org_id, access_token, refresh_token, scopes, installed_by, status, installed_at, refreshed_at
         FROM installations LIMIT 2`,
      )
      .all<InstallationRecord>();
    if (result.results.length !== 1) return null;
    return result.results[0] ?? null;
  }

  async delete(orgId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM installations WHERE org_id = ?")
      .bind(orgId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class ProjectStore {
  constructor(private readonly db: D1Database) {}

  async upsert(input: {
    teamId: string;
    repoUrl: string;
    defaultBranch?: string;
    engine?: string;
    model?: string | null;
    maxTurns?: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO projects (team_id, repo_url, default_branch, engine, model, max_turns)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id) DO UPDATE SET
           repo_url       = excluded.repo_url,
           default_branch = excluded.default_branch,
           engine         = excluded.engine,
           model          = excluded.model,
           max_turns      = excluded.max_turns,
           updated_at     = datetime('now')`,
      )
      .bind(
        input.teamId,
        input.repoUrl,
        input.defaultBranch ?? "main",
        input.engine ?? "pi",
        input.model ?? null,
        input.maxTurns ?? 10,
      )
      .run();
  }

  async get(teamId: string): Promise<ProjectRecord | null> {
    return await this.db
      .prepare(
        `SELECT team_id, repo_url, default_branch, engine, model, max_turns, updated_at
         FROM projects WHERE team_id = ?`,
      )
      .bind(teamId)
      .first<ProjectRecord>();
  }

  async list(): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT team_id, repo_url, default_branch, engine, model, max_turns, updated_at
         FROM projects ORDER BY team_id`,
      )
      .all<ProjectRecord>();
    return result.results;
  }

  async delete(teamId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM projects WHERE team_id = ?")
      .bind(teamId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}
