/**
 * D1-backed repository for the linear-agent worker.
 *
 * Tables (multi-tenant schema, see migrations/0002_multi_tenant.sql):
 *   - `installations` — per-org OAuth token (keyed by org_id).
 *   - `projects`      — per-team config: repo URL, engine, model,
 *     max_turns, scope, system_prompt_override (keyed by org_id +
 *     linear_team_id).
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
  id: number;
  org_id: string;
  linear_team_id: string;
  repo_url: string;
  default_branch: string;
  engine: string;
  model: string | null;
  max_turns: number;
  scope: string | null;
  system_prompt_override: string | null;
  updated_at: string;
}

export class InstallationStore {
  constructor(private readonly db: D1Database) {}

  private static readonly COLUMNS =
    "id, org_id, access_token, refresh_token, scopes, installed_by, status, installed_at, refreshed_at";

  async upsert(
    orgId: string,
    accessToken: string,
    scopes: string,
    installedBy: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO installations (org_id, access_token, scopes, installed_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           access_token = excluded.access_token,
           scopes       = excluded.scopes,
           refreshed_at = datetime('now')`,
      )
      .bind(orgId, accessToken, scopes, installedBy)
      .run();
  }

  async get(orgId: string): Promise<InstallationRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${InstallationStore.COLUMNS}
         FROM installations WHERE org_id = ?`,
      )
      .bind(orgId)
      .first<InstallationRecord>();
  }

  async getOnlyInstallation(): Promise<InstallationRecord | null> {
    const result = await this.db
      .prepare(
        `SELECT ${InstallationStore.COLUMNS}
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

  private static readonly COLUMNS =
    "id, org_id, linear_team_id, repo_url, default_branch, engine, model, max_turns, scope, system_prompt_override, updated_at";

  async upsert(input: {
    orgId: string;
    linearTeamId: string;
    repoUrl: string;
    defaultBranch?: string;
    engine?: string;
    model?: string | null;
    maxTurns?: number;
    scope?: string | null;
    systemPromptOverride?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO projects (org_id, linear_team_id, repo_url, default_branch, engine, model, max_turns, scope, system_prompt_override)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, linear_team_id) DO UPDATE SET
           repo_url               = excluded.repo_url,
           default_branch         = excluded.default_branch,
           engine                 = excluded.engine,
           model                  = excluded.model,
           max_turns              = excluded.max_turns,
           scope                  = excluded.scope,
           system_prompt_override = excluded.system_prompt_override,
           updated_at             = datetime('now')`,
      )
      .bind(
        input.orgId,
        input.linearTeamId,
        input.repoUrl,
        input.defaultBranch ?? "main",
        input.engine ?? "pi",
        input.model ?? null,
        input.maxTurns ?? 10,
        input.scope ?? null,
        input.systemPromptOverride ?? null,
      )
      .run();
  }

  async getByTeamId(orgId: string, linearTeamId: string): Promise<ProjectRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${ProjectStore.COLUMNS}
         FROM projects WHERE org_id = ? AND linear_team_id = ?`,
      )
      .bind(orgId, linearTeamId)
      .first<ProjectRecord>();
  }

  async get(linearTeamId: string): Promise<ProjectRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${ProjectStore.COLUMNS}
         FROM projects WHERE linear_team_id = ?`,
      )
      .bind(linearTeamId)
      .first<ProjectRecord>();
  }

  async listByOrg(orgId: string): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT ${ProjectStore.COLUMNS}
         FROM projects WHERE org_id = ? ORDER BY linear_team_id`,
      )
      .bind(orgId)
      .all<ProjectRecord>();
    return result.results;
  }

  async list(): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT ${ProjectStore.COLUMNS}
         FROM projects ORDER BY org_id, linear_team_id`,
      )
      .all<ProjectRecord>();
    return result.results;
  }

  async delete(orgId: string, linearTeamId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM projects WHERE org_id = ? AND linear_team_id = ?")
      .bind(orgId, linearTeamId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}
