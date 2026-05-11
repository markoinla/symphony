/**
 * D1-backed repositories for the linear-agent worker.
 *
 * Schema:
 *   - `installations` — one row per Linear org OAuth. After SYM-268 it
 *     also carries the GitHub App installation id, the `actor=app`
 *     refresh token, and bookkeeping fields (status, installed_by,
 *     expires_at, organization_name).
 *   - `projects` — per-team config: repo URL, engine/model overrides,
 *     organization scoping, optional system_prompt_override.
 *   - `users` — per-human dashboard logins from Linear `actor=user`
 *     OAuth. Also the source for Linear MCP bearer tokens used at
 *     /run time.
 *   - `org_credentials` — envelope-encrypted per-org secrets
 *     (Anthropic / OpenAI / Cloudflare Workers AI keys, GH PAT
 *     fallback, custom MCP bearers).
 *
 * Migrations: see `workers/linear-agent/migrations/`.
 *
 * Style: column names are SQL-flavored (`organization_id`,
 * `max_turns`); the typed records mirror them via snake_case so we
 * don't have to remember which mapping is which.
 */

import type { CredentialBlob } from "./crypto";

export interface InstallationRecord {
  organization_id: string;
  access_token: string;
  refresh_token: string | null;
  installed_by_linear_user_id: string | null;
  status: string;
  github_app_installation_id: number | null;
  expires_at: string | null;
  organization_name: string | null;
  scopes: string;
  installed_at: string;
  refreshed_at: string;
}

export interface ProjectRecord {
  team_id: string;
  organization_id: string | null;
  repo_url: string;
  default_branch: string;
  engine: string;
  model: string | null;
  max_turns: number;
  scope_override: string | null;
  system_prompt_override: string | null;
  updated_at: string;
}

export interface UserRecord {
  id: string;
  organization_id: string;
  linear_user_id: string;
  email: string | null;
  name: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  scopes: string;
  created_at: string;
  updated_at: string;
}

export interface OrgCredentialRecord extends CredentialBlob {
  organization_id: string;
  kind: string;
  updated_at: string;
}

const INSTALLATION_COLUMNS =
  "organization_id, access_token, refresh_token, installed_by_linear_user_id, status, github_app_installation_id, expires_at, organization_name, scopes, installed_at, refreshed_at";

const PROJECT_COLUMNS =
  "team_id, organization_id, repo_url, default_branch, engine, model, max_turns, scope_override, system_prompt_override, updated_at";

const USER_COLUMNS =
  "id, organization_id, linear_user_id, email, name, access_token, refresh_token, expires_at, scopes, created_at, updated_at";

const CREDENTIAL_COLUMNS =
  "organization_id, kind, ciphertext, dek_ciphertext, kek_version, updated_at";

export class InstallationStore {
  constructor(private readonly db: D1Database) {}

  async upsert(input: {
    organizationId: string;
    accessToken: string;
    scopes: string;
    refreshToken?: string | null;
    installedByLinearUserId?: string | null;
    expiresAt?: string | null;
    organizationName?: string | null;
    status?: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO installations (
           organization_id, access_token, refresh_token,
           installed_by_linear_user_id, status,
           expires_at, organization_name, scopes
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id) DO UPDATE SET
           access_token                   = excluded.access_token,
           refresh_token                  = COALESCE(excluded.refresh_token, installations.refresh_token),
           installed_by_linear_user_id    = COALESCE(excluded.installed_by_linear_user_id, installations.installed_by_linear_user_id),
           status                         = excluded.status,
           expires_at                     = COALESCE(excluded.expires_at, installations.expires_at),
           organization_name              = COALESCE(excluded.organization_name, installations.organization_name),
           scopes                         = excluded.scopes,
           refreshed_at                   = datetime('now')`,
      )
      .bind(
        input.organizationId,
        input.accessToken,
        input.refreshToken ?? null,
        input.installedByLinearUserId ?? null,
        input.status ?? "active",
        input.expiresAt ?? null,
        input.organizationName ?? null,
        input.scopes,
      )
      .run();
  }

  async get(organizationId: string): Promise<InstallationRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${INSTALLATION_COLUMNS} FROM installations WHERE organization_id = ?`,
      )
      .bind(organizationId)
      .first<InstallationRecord>();
  }

  /**
   * Single-org fallback for webhook deliveries that don't carry an
   * `organizationId` field. If there's exactly one install, return
   * it; otherwise return null and force the caller to look up by org
   * id.
   */
  async getOnlyInstallation(): Promise<InstallationRecord | null> {
    const result = await this.db
      .prepare(
        `SELECT ${INSTALLATION_COLUMNS} FROM installations LIMIT 2`,
      )
      .all<InstallationRecord>();
    if (result.results.length !== 1) return null;
    return result.results[0] ?? null;
  }

  /**
   * Record a GitHub App installation against an org. Distinct from
   * `upsert` so the GH install callback doesn't need to know about
   * Linear OAuth fields.
   */
  async setGithubAppInstallationId(
    organizationId: string,
    installationId: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE installations
         SET github_app_installation_id = ?,
             refreshed_at = datetime('now')
         WHERE organization_id = ?`,
      )
      .bind(installationId, organizationId)
      .run();
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
    organizationId?: string | null;
    defaultBranch?: string;
    engine?: string;
    model?: string | null;
    maxTurns?: number;
    scopeOverride?: string | null;
    systemPromptOverride?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO projects (
           team_id, organization_id, repo_url, default_branch, engine, model, max_turns,
           scope_override, system_prompt_override
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id) DO UPDATE SET
           organization_id        = COALESCE(excluded.organization_id, projects.organization_id),
           repo_url               = excluded.repo_url,
           default_branch         = excluded.default_branch,
           engine                 = excluded.engine,
           model                  = excluded.model,
           max_turns              = excluded.max_turns,
           scope_override         = excluded.scope_override,
           system_prompt_override = excluded.system_prompt_override,
           updated_at             = datetime('now')`,
      )
      .bind(
        input.teamId,
        input.organizationId ?? null,
        input.repoUrl,
        input.defaultBranch ?? "main",
        input.engine ?? "pi",
        input.model ?? null,
        input.maxTurns ?? 10,
        input.scopeOverride ?? null,
        input.systemPromptOverride ?? null,
      )
      .run();
  }

  async get(teamId: string): Promise<ProjectRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE team_id = ?`,
      )
      .bind(teamId)
      .first<ProjectRecord>();
  }

  async list(): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY team_id`,
      )
      .all<ProjectRecord>();
    return result.results;
  }

  async listForOrg(organizationId: string): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE organization_id = ? ORDER BY team_id`,
      )
      .bind(organizationId)
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

export class UserStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Insert or update a user row keyed by (organization_id,
   * linear_user_id). The dashboard cookie carries `id` so we stamp a
   * stable UUID on first insert; refresh callers reuse it.
   */
  async upsert(input: {
    id: string;
    organizationId: string;
    linearUserId: string;
    email?: string | null;
    name?: string | null;
    accessToken: string;
    refreshToken?: string | null;
    expiresAt: string;
    scopes: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO users (
           id, organization_id, linear_user_id, email, name,
           access_token, refresh_token, expires_at, scopes
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, linear_user_id) DO UPDATE SET
           email          = COALESCE(excluded.email, users.email),
           name           = COALESCE(excluded.name, users.name),
           access_token   = excluded.access_token,
           refresh_token  = COALESCE(excluded.refresh_token, users.refresh_token),
           expires_at     = excluded.expires_at,
           scopes         = excluded.scopes,
           updated_at     = datetime('now')`,
      )
      .bind(
        input.id,
        input.organizationId,
        input.linearUserId,
        input.email ?? null,
        input.name ?? null,
        input.accessToken,
        input.refreshToken ?? null,
        input.expiresAt,
        input.scopes,
      )
      .run();
  }

  async getById(id: string): Promise<UserRecord | null> {
    return await this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
      .bind(id)
      .first<UserRecord>();
  }

  async getByOrgAndLinearId(
    organizationId: string,
    linearUserId: string,
  ): Promise<UserRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${USER_COLUMNS} FROM users
         WHERE organization_id = ? AND linear_user_id = ?`,
      )
      .bind(organizationId, linearUserId)
      .first<UserRecord>();
  }

  async updateTokens(input: {
    id: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE users
         SET access_token  = ?,
             refresh_token = COALESCE(?, refresh_token),
             expires_at    = ?,
             updated_at    = datetime('now')
         WHERE id = ?`,
      )
      .bind(input.accessToken, input.refreshToken, input.expiresAt, input.id)
      .run();
  }
}

export class OrgCredentialStore {
  constructor(private readonly db: D1Database) {}

  async upsert(input: {
    organizationId: string;
    kind: string;
    blob: CredentialBlob;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO org_credentials (
           organization_id, kind, ciphertext, dek_ciphertext, kek_version
         )
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, kind) DO UPDATE SET
           ciphertext      = excluded.ciphertext,
           dek_ciphertext  = excluded.dek_ciphertext,
           kek_version     = excluded.kek_version,
           updated_at      = datetime('now')`,
      )
      .bind(
        input.organizationId,
        input.kind,
        input.blob.ciphertext,
        input.blob.dek_ciphertext,
        input.blob.kek_version,
      )
      .run();
  }

  async get(
    organizationId: string,
    kind: string,
  ): Promise<OrgCredentialRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM org_credentials
         WHERE organization_id = ? AND kind = ?`,
      )
      .bind(organizationId, kind)
      .first<OrgCredentialRecord>();
  }

  /**
   * List the *kinds* an org has stored, without exposing ciphertext.
   * Powers the Integrations tab's "is X configured?" UI.
   */
  async listKinds(organizationId: string): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT kind FROM org_credentials WHERE organization_id = ? ORDER BY kind`,
      )
      .bind(organizationId)
      .all<{ kind: string }>();
    return result.results.map((r) => r.kind);
  }

  async delete(organizationId: string, kind: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM org_credentials WHERE organization_id = ? AND kind = ?`,
      )
      .bind(organizationId, kind)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}
