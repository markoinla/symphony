/**
 * D1-backed repository for the linear-agent worker.
 *
 * Three tables:
 *   - `installations` — one row per Linear org OAuth (app install).
 *   - `projects`      — per-team config: repo URL, engine, model, max_turns.
 *   - `users`         — per-user OAuth tokens for dashboard login.
 *
 * Migrations: `migrations/0001_init.sql`, `migrations/0002_users.sql`.
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

export interface UserRecord {
  linear_user_id: string;
  organization_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  email: string | null;
  name: string | null;
  created_at: string;
  refreshed_at: string;
}

export class UserStore {
  constructor(private readonly db: D1Database) {}

  async upsert(input: {
    linearUserId: string;
    organizationId: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
    email?: string | null;
    name?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO users (linear_user_id, organization_id, access_token, refresh_token, expires_at, email, name)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(linear_user_id) DO UPDATE SET
           organization_id = excluded.organization_id,
           access_token    = excluded.access_token,
           refresh_token   = excluded.refresh_token,
           expires_at      = excluded.expires_at,
           email           = excluded.email,
           name            = excluded.name,
           refreshed_at    = datetime('now')`,
      )
      .bind(
        input.linearUserId,
        input.organizationId,
        input.accessToken,
        input.refreshToken ?? null,
        input.expiresAt ?? null,
        input.email ?? null,
        input.name ?? null,
      )
      .run();
  }

  async getByLinearUserId(linearUserId: string): Promise<UserRecord | null> {
    return await this.db
      .prepare(
        `SELECT linear_user_id, organization_id, access_token, refresh_token,
                expires_at, email, name, created_at, refreshed_at
         FROM users WHERE linear_user_id = ?`,
      )
      .bind(linearUserId)
      .first<UserRecord>();
  }

  async listByOrg(organizationId: string): Promise<UserRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT linear_user_id, organization_id, access_token, refresh_token,
                expires_at, email, name, created_at, refreshed_at
         FROM users WHERE organization_id = ? ORDER BY created_at`,
      )
      .bind(organizationId)
      .all<UserRecord>();
    return result.results;
  }
}

export interface DashboardSessionRecord {
  token: string;
  linear_user_id: string;
  created_at: string;
  expires_at: string;
}

export class SessionStore {
  constructor(private readonly db: D1Database) {}

  async create(linearUserId: string, ttlDays = 30): Promise<string> {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    await this.db
      .prepare(
        `INSERT INTO dashboard_sessions (token, linear_user_id, expires_at)
         VALUES (?, ?, ?)`,
      )
      .bind(token, linearUserId, expiresAt)
      .run();
    return token;
  }

  async validate(token: string): Promise<UserRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT u.linear_user_id, u.organization_id, u.access_token,
                u.refresh_token, u.expires_at, u.email, u.name,
                u.created_at, u.refreshed_at
         FROM dashboard_sessions s
         JOIN users u ON u.linear_user_id = s.linear_user_id
         WHERE s.token = ? AND s.expires_at > datetime('now')`,
      )
      .bind(token)
      .first<UserRecord>();
    return row ?? null;
  }

  async delete(token: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM dashboard_sessions WHERE token = ?")
      .bind(token)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deleteByUser(linearUserId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM dashboard_sessions WHERE linear_user_id = ?")
      .bind(linearUserId)
      .run();
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
