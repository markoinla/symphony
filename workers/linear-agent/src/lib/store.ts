/**
 * D1-backed repository for the linear-agent worker.
 *
 * Two tables:
 *   - `installations` — one row per Linear org OAuth (replaces the
 *     single KV `access_token` from item 1).
 *   - `projects`     — per-team config: repo URL, engine, model,
 *     max_turns (replaces `PROJECT_MAPPINGS_JSON`).
 *
 * Migration: see `workers/linear-agent/migrations/0001_init.sql`.
 *
 * Style note: column names are SQL-flavored (`organization_id`,
 * `max_turns`); the typed records mirror them via `snake_case` so we
 * don't have to remember which mapping is which. Callers that prefer
 * camelCase wrap the read in their own adapter.
 */

export interface InstallationRecord {
  organization_id: string;
  access_token: string;
  scopes: string;
  github_app_installation_id: number | null;
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
   * Insert or replace the installation token for an organization. The
   * caller passes the token Linear returned from the OAuth code
   * exchange. Multiple re-installs of the same org just overwrite the
   * row.
   */
  async upsert(
    organizationId: string,
    accessToken: string,
    scopes: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO installations (organization_id, access_token, scopes)
         VALUES (?, ?, ?)
         ON CONFLICT(organization_id) DO UPDATE SET
           access_token = excluded.access_token,
           scopes       = excluded.scopes,
           refreshed_at = datetime('now')`,
      )
      .bind(organizationId, accessToken, scopes)
      .run();
  }

  async get(organizationId: string): Promise<InstallationRecord | null> {
    return await this.db
      .prepare(
        `SELECT organization_id, access_token, scopes, github_app_installation_id, installed_at, refreshed_at
         FROM installations WHERE organization_id = ?`,
      )
      .bind(organizationId)
      .first<InstallationRecord>();
  }

  /**
   * Single-org fallback for webhook deliveries that don't carry an
   * `organizationId` field. If there's exactly one install, return it;
   * otherwise return null and force the caller to look up by org id.
   */
  async getOnlyInstallation(): Promise<InstallationRecord | null> {
    const result = await this.db
      .prepare(
        `SELECT organization_id, access_token, scopes, github_app_installation_id, installed_at, refreshed_at
         FROM installations LIMIT 2`,
      )
      .all<InstallationRecord>();
    if (result.results.length !== 1) return null;
    return result.results[0] ?? null;
  }

  async updateGitHubAppInstallation(
    organizationId: string,
    githubAppInstallationId: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE installations
         SET github_app_installation_id = ?, refreshed_at = datetime('now')
         WHERE organization_id = ?`,
      )
      .bind(githubAppInstallationId, organizationId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async delete(organizationId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM installations WHERE organization_id = ?")
      .bind(organizationId)
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
