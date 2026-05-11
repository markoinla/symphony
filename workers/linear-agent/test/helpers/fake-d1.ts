/**
 * Minimal D1Database stub for unit tests. Supports the subset of SQL
 * the linear-agent worker uses (multi-tenant schema from 0002):
 * SELECT/INSERT/DELETE against `installations` and `projects`.
 */

interface InstallationRow {
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

interface ProjectRow {
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

interface UserRow {
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

interface OrgCredentialRow {
  id: number;
  org_id: string;
  kind: string;
  ciphertext: ArrayBuffer;
  dek_ciphertext: ArrayBuffer;
  kek_version: number;
  created_at: string;
  updated_at: string;
}

interface GitHubInstallRow {
  org_id: string;
  install_id: number;
  account_login: string;
  account_type: string;
  repo_selection: string;
  selected_repos: string | null;
  created_at: string;
  updated_at: string;
}

interface DashboardSessionRow {
  token: string;
  linear_user_id: string;
  created_at: string;
  expires_at: string;
}

let nextInstallId = 1;
let nextProjectId = 1;
let nextCredentialId = 1;

export class FakeD1 {
  installations = new Map<string, InstallationRow>();
  projects = new Map<string, ProjectRow>();
  users = new Map<string, UserRow>();
  orgCredentials = new Map<string, OrgCredentialRow>();
  githubInstalls = new Map<string, GitHubInstallRow>();
  dashboardSessions = new Map<string, DashboardSessionRow>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  private bindings: unknown[] = [];

  constructor(private db: FakeD1, private sql: string) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async run() {
    const sql = normalizeSql(this.sql);
    if (/^INSERT INTO installations/i.test(sql)) {
      const [orgId, token, scopes, installedBy] = this.bindings as [string, string, string, string];
      const now = new Date().toISOString();
      const existing = this.db.installations.get(orgId);
      this.db.installations.set(orgId, {
        id: existing?.id ?? nextInstallId++,
        org_id: orgId,
        access_token: token,
        refresh_token: null,
        scopes,
        installed_by: installedBy,
        status: "active",
        github_app_installation_id: existing?.github_app_installation_id ?? null,
        installed_at: existing?.installed_at ?? now,
        refreshed_at: now,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^UPDATE installations/i.test(sql)) {
      const [ghInstId, orgId] = this.bindings as [number, string];
      const existing = this.db.installations.get(orgId);
      if (existing) {
        existing.github_app_installation_id = ghInstId;
        existing.refreshed_at = new Date().toISOString();
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (/^DELETE FROM installations/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const had = this.db.installations.has(orgId);
      this.db.installations.delete(orgId);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }
    if (/^INSERT INTO projects/i.test(sql)) {
      const [orgId, linearTeamId, repoUrl, defaultBranch, engine, model, maxTurns, scope, systemPromptOverride] =
        this.bindings as [string, string, string, string, string, string | null, number, string | null, string | null];
      const key = `${orgId}:${linearTeamId}`;
      const existing = this.db.projects.get(key);
      this.db.projects.set(key, {
        id: existing?.id ?? nextProjectId++,
        org_id: orgId,
        linear_team_id: linearTeamId,
        repo_url: repoUrl,
        default_branch: defaultBranch,
        engine,
        model,
        max_turns: maxTurns,
        scope,
        system_prompt_override: systemPromptOverride,
        updated_at: new Date().toISOString(),
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM projects/i.test(sql)) {
      const [orgId, linearTeamId] = this.bindings as [string, string];
      const key = `${orgId}:${linearTeamId}`;
      const had = this.db.projects.has(key);
      this.db.projects.delete(key);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }
    if (/^INSERT INTO org_credentials/i.test(sql)) {
      const [orgId, kind, ciphertext, dekCiphertext, kekVersion] = this.bindings as [
        string, string, ArrayBuffer, ArrayBuffer, number,
      ];
      const key = `${orgId}:${kind}`;
      const existing = this.db.orgCredentials.get(key);
      const now = new Date().toISOString();
      this.db.orgCredentials.set(key, {
        id: existing?.id ?? nextCredentialId++,
        org_id: orgId,
        kind,
        ciphertext,
        dek_ciphertext: dekCiphertext,
        kek_version: kekVersion,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM org_credentials/i.test(sql)) {
      const [orgId, kind] = this.bindings as [string, string];
      const key = `${orgId}:${kind}`;
      const had = this.db.orgCredentials.has(key);
      this.db.orgCredentials.delete(key);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }
    if (/^INSERT INTO github_installs/i.test(sql)) {
      const [orgId, installId, accountLogin, accountType, repoSelection, selectedRepos] =
        this.bindings as [string, number, string, string, string, string | null];
      const now = new Date().toISOString();
      this.db.githubInstalls.set(orgId, {
        org_id: orgId,
        install_id: installId,
        account_login: accountLogin,
        account_type: accountType,
        repo_selection: repoSelection,
        selected_repos: selectedRepos,
        created_at: this.db.githubInstalls.get(orgId)?.created_at ?? now,
        updated_at: now,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM github_installs/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const had = this.db.githubInstalls.has(orgId);
      this.db.githubInstalls.delete(orgId);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }
    if (/^INSERT INTO dashboard_sessions/i.test(sql)) {
      const [token, linearUserId, expiresAt] = this.bindings as [string, string, string];
      this.db.dashboardSessions.set(token, {
        token,
        linear_user_id: linearUserId,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM dashboard_sessions WHERE token/i.test(sql)) {
      const [token] = this.bindings as [string];
      const had = this.db.dashboardSessions.has(token);
      this.db.dashboardSessions.delete(token);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }
    if (/^DELETE FROM dashboard_sessions WHERE linear_user_id/i.test(sql)) {
      const [userId] = this.bindings as [string];
      let count = 0;
      for (const [k, v] of this.db.dashboardSessions) {
        if (v.linear_user_id === userId) {
          this.db.dashboardSessions.delete(k);
          count++;
        }
      }
      return { success: true, meta: { changes: count } };
    }
    if (/^INSERT INTO users/i.test(sql)) {
      const [linearUserId, orgId, accessToken, refreshToken, expiresAt, email, name] =
        this.bindings as [string, string, string, string | null, string | null, string | null, string | null];
      const now = new Date().toISOString();
      this.db.users.set(linearUserId, {
        linear_user_id: linearUserId,
        organization_id: orgId,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        email,
        name,
        created_at: this.db.users.get(linearUserId)?.created_at ?? now,
        refreshed_at: now,
      });
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`FakeD1.run: unsupported SQL: ${sql}`);
  }

  async first<T>(): Promise<T | null> {
    const sql = normalizeSql(this.sql);
    if (/^SELECT .* FROM installations WHERE org_id/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      return (this.db.installations.get(orgId) as unknown as T) ?? null;
    }
    if (/^SELECT .* FROM projects WHERE org_id = \? AND linear_team_id/i.test(sql)) {
      const [orgId, linearTeamId] = this.bindings as [string, string];
      const key = `${orgId}:${linearTeamId}`;
      return (this.db.projects.get(key) as unknown as T) ?? null;
    }
    if (/^SELECT .* FROM projects WHERE linear_team_id/i.test(sql)) {
      const [linearTeamId] = this.bindings as [string];
      for (const row of this.db.projects.values()) {
        if (row.linear_team_id === linearTeamId) return row as unknown as T;
      }
      return null;
    }
    if (/^SELECT .* FROM org_credentials WHERE org_id = \? AND kind/i.test(sql)) {
      const [orgId, kind] = this.bindings as [string, string];
      const key = `${orgId}:${kind}`;
      return (this.db.orgCredentials.get(key) as unknown as T) ?? null;
    }
    if (/^SELECT .* FROM users WHERE linear_user_id/i.test(sql)) {
      const [userId] = this.bindings as [string];
      return (this.db.users.get(userId) as unknown as T) ?? null;
    }
    if (/^SELECT .* FROM dashboard_sessions s.*JOIN users/i.test(sql)) {
      const [token] = this.bindings as [string];
      const session = this.db.dashboardSessions.get(token);
      if (!session) return null;
      if (new Date(session.expires_at) <= new Date()) return null;
      const user = this.db.users.get(session.linear_user_id);
      return (user as unknown as T) ?? null;
    }
    if (/^SELECT .* FROM github_installs WHERE org_id/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      return (this.db.githubInstalls.get(orgId) as unknown as T) ?? null;
    }
    throw new Error(`FakeD1.first: unsupported SQL: ${sql}`);
  }

  async all<T>(): Promise<{ success: true; results: T[] }> {
    const sql = normalizeSql(this.sql);
    if (/^SELECT .* FROM installations LIMIT 2/i.test(sql)) {
      return {
        success: true,
        results: Array.from(this.db.installations.values()).slice(0, 2) as unknown as T[],
      };
    }
    if (/^SELECT .* FROM installations ORDER BY installed_at/i.test(sql)) {
      return {
        success: true,
        results: Array.from(this.db.installations.values()) as unknown as T[],
      };
    }
    if (/^SELECT .* FROM projects WHERE org_id = \? ORDER BY linear_team_id/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const rows = Array.from(this.db.projects.values()).filter((r) => r.org_id === orgId);
      return { success: true, results: rows as unknown as T[] };
    }
    if (/^SELECT .* FROM projects ORDER BY org_id/i.test(sql)) {
      return {
        success: true,
        results: Array.from(this.db.projects.values()) as unknown as T[],
      };
    }
    if (/^SELECT kind FROM org_credentials WHERE org_id = \? ORDER BY kind/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const kinds = Array.from(this.db.orgCredentials.values())
        .filter((r) => r.org_id === orgId)
        .map((r) => ({ kind: r.kind }))
        .sort((a, b) => a.kind.localeCompare(b.kind));
      return { success: true, results: kinds as unknown as T[] };
    }
    if (/^SELECT .* FROM users WHERE organization_id .* ORDER BY created_at/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const filtered = Array.from(this.db.users.values()).filter(
        (u) => u.organization_id === orgId,
      );
      return { success: true, results: filtered as unknown as T[] };
    }
    if (/^SELECT .* FROM github_installs ORDER BY created_at/i.test(sql)) {
      return {
        success: true,
        results: Array.from(this.db.githubInstalls.values()) as unknown as T[],
      };
    }
    throw new Error(`FakeD1.all: unsupported SQL: ${sql}`);
  }
}

function normalizeSql(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}
