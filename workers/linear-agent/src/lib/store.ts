/**
 * D1-backed repository for the linear-agent worker.
 *
 * Tables (multi-tenant schema, see migrations/0002_multi_tenant.sql):
 *   - `installations` — per-org OAuth token (keyed by org_id).
 *   - `projects`      — per-team config: repo URL, engine, model,
 *     max_turns, scope, system_prompt_override (keyed by org_id +
 *     linear_team_id).
 *   - `users`         — per-user OAuth tokens for dashboard login.
 *   - `sessions`      — agent session runs with debug payload.
 */

export interface InstallationRecord {
  id: number;
  org_id: string;
  access_token: string;
  refresh_token: string | null;
  scopes: string;
  installed_by: string;
  status: string;
  github_app_installation_id: number | null;
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
    "id, org_id, access_token, refresh_token, scopes, installed_by, status, github_app_installation_id, installed_at, refreshed_at";

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

  async updateGitHubAppInstallation(
    orgId: string,
    githubAppInstallationId: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE installations
         SET github_app_installation_id = ?, refreshed_at = datetime('now')
         WHERE org_id = ?`,
      )
      .bind(githubAppInstallationId, orgId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async delete(orgId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM installations WHERE org_id = ?")
      .bind(orgId)
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

export class AgentSessionStore {
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

export interface GitHubInstallRecord {
  org_id: string;
  install_id: number;
  account_login: string;
  account_type: string;
  repo_selection: string;
  selected_repos: string | null;
  created_at: string;
  updated_at: string;
}

export class GitHubInstallStore {
  constructor(private readonly db: D1Database) {}

  async upsert(input: {
    orgId: string;
    installId: number;
    accountLogin: string;
    accountType?: string;
    repoSelection?: string;
    selectedRepos?: string[] | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO github_installs (org_id, install_id, account_login, account_type, repo_selection, selected_repos)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           install_id      = excluded.install_id,
           account_login   = excluded.account_login,
           account_type    = excluded.account_type,
           repo_selection  = excluded.repo_selection,
           selected_repos  = excluded.selected_repos,
           updated_at      = datetime('now')`,
      )
      .bind(
        input.orgId,
        input.installId,
        input.accountLogin,
        input.accountType ?? "Organization",
        input.repoSelection ?? "all",
        input.selectedRepos ? JSON.stringify(input.selectedRepos) : null,
      )
      .run();
  }

  async get(orgId: string): Promise<GitHubInstallRecord | null> {
    return await this.db
      .prepare(
        `SELECT org_id, install_id, account_login, account_type, repo_selection, selected_repos, created_at, updated_at
         FROM github_installs WHERE org_id = ?`,
      )
      .bind(orgId)
      .first<GitHubInstallRecord>();
  }

  async list(): Promise<GitHubInstallRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT org_id, install_id, account_login, account_type, repo_selection, selected_repos, created_at, updated_at
         FROM github_installs ORDER BY created_at DESC`,
      )
      .all<GitHubInstallRecord>();
    return result.results;
  }

  async delete(orgId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM github_installs WHERE org_id = ?")
      .bind(orgId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}
