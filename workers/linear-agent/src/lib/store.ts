/**
 * D1-backed repository for the linear-agent worker.
 *
 * Four tables:
 *   - `installations` — one row per Linear org OAuth (app install).
 *   - `projects`      — per-team config: repo URL, engine, model, max_turns.
 *   - `users`         — per-user OAuth tokens for dashboard login.
 *   - `sessions`      — agent session runs with debug payload.
 *
 * Migrations: `migrations/0001_init.sql`, `migrations/0002_users.sql`,
 *             `migrations/0003_sessions.sql`.
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

export interface SessionRecord {
  id: string;
  linear_issue_id: string | null;
  linear_issue_title: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  triggered_by: string | null;
  team: string | null;
  repo: string | null;
  prompt: string | null;
  config_snapshot: string | null;
  stderr: string | null;
  dispatcher_logs: string | null;
  messages: string | null;
  error: string | null;
}

export interface SessionListFilter {
  team?: string;
  repo?: string;
  status?: string;
  triggered_by?: string;
  limit?: number;
  offset?: number;
}

export class SessionStore {
  constructor(private readonly db: D1Database) {}

  async create(input: {
    id: string;
    linearIssueId?: string | null;
    linearIssueTitle?: string | null;
    status?: string;
    triggeredBy?: string | null;
    team?: string | null;
    repo?: string | null;
    prompt?: string | null;
    configSnapshot?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (id, linear_issue_id, linear_issue_title, status, triggered_by, team, repo, prompt, config_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.linearIssueId ?? null,
        input.linearIssueTitle ?? null,
        input.status ?? "running",
        input.triggeredBy ?? null,
        input.team ?? null,
        input.repo ?? null,
        input.prompt ?? null,
        input.configSnapshot ? JSON.stringify(input.configSnapshot) : null,
      )
      .run();
  }

  async update(
    id: string,
    fields: {
      status?: string;
      completedAt?: string;
      error?: string | null;
      stderr?: string | null;
      dispatcherLogs?: string | null;
      messages?: string | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (fields.status !== undefined) {
      sets.push("status = ?");
      values.push(fields.status);
    }
    if (fields.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(fields.completedAt);
    }
    if (fields.error !== undefined) {
      sets.push("error = ?");
      values.push(fields.error ?? null);
    }
    if (fields.stderr !== undefined) {
      sets.push("stderr = ?");
      values.push(fields.stderr ?? null);
    }
    if (fields.dispatcherLogs !== undefined) {
      sets.push("dispatcher_logs = ?");
      values.push(fields.dispatcherLogs ?? null);
    }
    if (fields.messages !== undefined) {
      sets.push("messages = ?");
      values.push(fields.messages ?? null);
    }

    if (sets.length === 0) return;

    await this.db
      .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }

  async get(id: string): Promise<SessionRecord | null> {
    return await this.db
      .prepare(
        `SELECT id, linear_issue_id, linear_issue_title, status, started_at,
                completed_at, triggered_by, team, repo, prompt,
                config_snapshot, stderr, dispatcher_logs, messages, error
         FROM sessions WHERE id = ?`,
      )
      .bind(id)
      .first<SessionRecord>();
  }

  async list(filter?: SessionListFilter): Promise<SessionRecord[]> {
    const conditions: string[] = [];
    const values: string[] = [];

    if (filter?.team) {
      conditions.push("team = ?");
      values.push(filter.team);
    }
    if (filter?.repo) {
      conditions.push("repo = ?");
      values.push(filter.repo);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      values.push(filter.status);
    }
    if (filter?.triggered_by) {
      conditions.push("triggered_by = ?");
      values.push(filter.triggered_by);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    const result = await this.db
      .prepare(
        `SELECT id, linear_issue_id, linear_issue_title, status, started_at,
                completed_at, triggered_by, team, repo, prompt,
                config_snapshot, stderr, dispatcher_logs, messages, error
         FROM sessions ${where}
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...values, limit, offset)
      .all<SessionRecord>();
    return result.results;
  }

  async listRunning(): Promise<SessionRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, linear_issue_id, linear_issue_title, status, started_at,
                completed_at, triggered_by, team, repo, prompt,
                config_snapshot, stderr, dispatcher_logs, messages, error
         FROM sessions WHERE status = 'running'
         ORDER BY started_at DESC`,
      )
      .all<SessionRecord>();
    return result.results;
  }
}
