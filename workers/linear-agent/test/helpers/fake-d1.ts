/**
 * Minimal D1Database stub for unit tests. Supports the subset of SQL
 * the linear-agent worker uses (SYM-268 schema): installations,
 * projects, users, org_credentials. Anything else throws so tests
 * fail loudly when the worker grows new queries we haven't stubbed.
 *
 * Keep this in lockstep with `src/lib/store.ts`. When you add a
 * query there, add a branch here.
 */

interface InstallationRow {
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

interface ProjectRow {
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

interface UserRow {
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

interface CredentialRow {
  organization_id: string;
  kind: string;
  ciphertext: Uint8Array;
  dek_ciphertext: Uint8Array;
  kek_version: number;
  updated_at: string;
}

export class FakeD1 {
  installations = new Map<string, InstallationRow>();
  projects = new Map<string, ProjectRow>();
  users = new Map<string, UserRow>();                  // keyed by `${org}|${linearUserId}`
  credentials = new Map<string, CredentialRow>();      // keyed by `${org}|${kind}`

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
      const [
        orgId,
        accessToken,
        refreshToken,
        installedByLinearUserId,
        status,
        expiresAt,
        organizationName,
        scopes,
      ] = this.bindings as [
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
      ];
      const now = new Date().toISOString();
      const existing = this.db.installations.get(orgId);
      this.db.installations.set(orgId, {
        organization_id: orgId,
        access_token: accessToken,
        refresh_token: refreshToken ?? existing?.refresh_token ?? null,
        installed_by_linear_user_id:
          installedByLinearUserId ??
          existing?.installed_by_linear_user_id ??
          null,
        status,
        github_app_installation_id: existing?.github_app_installation_id ?? null,
        expires_at: expiresAt ?? existing?.expires_at ?? null,
        organization_name: organizationName ?? existing?.organization_name ?? null,
        scopes,
        installed_at: existing?.installed_at ?? now,
        refreshed_at: now,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (/^UPDATE installations\s+SET github_app_installation_id/i.test(sql)) {
      const [installationId, orgId] = this.bindings as [number, string];
      const existing = this.db.installations.get(orgId);
      if (!existing) return { success: true, meta: { changes: 0 } };
      this.db.installations.set(orgId, {
        ...existing,
        github_app_installation_id: installationId,
        refreshed_at: new Date().toISOString(),
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (/^DELETE FROM installations/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const had = this.db.installations.has(orgId);
      this.db.installations.delete(orgId);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    if (/^INSERT INTO projects/i.test(sql)) {
      const [
        teamId,
        organizationId,
        repoUrl,
        defaultBranch,
        engine,
        model,
        maxTurns,
        scopeOverride,
        systemPromptOverride,
      ] = this.bindings as [
        string,
        string | null,
        string,
        string,
        string,
        string | null,
        number,
        string | null,
        string | null,
      ];
      const existing = this.db.projects.get(teamId);
      this.db.projects.set(teamId, {
        team_id: teamId,
        organization_id: organizationId ?? existing?.organization_id ?? null,
        repo_url: repoUrl,
        default_branch: defaultBranch,
        engine,
        model,
        max_turns: maxTurns,
        scope_override: scopeOverride,
        system_prompt_override: systemPromptOverride,
        updated_at: new Date().toISOString(),
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (/^DELETE FROM projects/i.test(sql)) {
      const [teamId] = this.bindings as [string];
      const had = this.db.projects.has(teamId);
      this.db.projects.delete(teamId);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    if (/^INSERT INTO users/i.test(sql)) {
      const [
        id,
        organizationId,
        linearUserId,
        email,
        name,
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
      ] = this.bindings as [
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string,
        string,
      ];
      const key = `${organizationId}|${linearUserId}`;
      const existing = this.db.users.get(key);
      const now = new Date().toISOString();
      this.db.users.set(key, {
        id,
        organization_id: organizationId,
        linear_user_id: linearUserId,
        email: email ?? existing?.email ?? null,
        name: name ?? existing?.name ?? null,
        access_token: accessToken,
        refresh_token: refreshToken ?? existing?.refresh_token ?? null,
        expires_at: expiresAt,
        scopes,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (/^UPDATE users\s+SET access_token/i.test(sql)) {
      const [accessToken, refreshToken, expiresAt, id] = this.bindings as [
        string,
        string | null,
        string,
        string,
      ];
      for (const [key, user] of this.db.users) {
        if (user.id === id) {
          this.db.users.set(key, {
            ...user,
            access_token: accessToken,
            refresh_token: refreshToken ?? user.refresh_token,
            expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          });
          return { success: true, meta: { changes: 1 } };
        }
      }
      return { success: true, meta: { changes: 0 } };
    }

    if (/^INSERT INTO org_credentials/i.test(sql)) {
      const [organizationId, kind, ciphertext, dekCiphertext, kekVersion] =
        this.bindings as [string, string, Uint8Array, Uint8Array, number];
      const key = `${organizationId}|${kind}`;
      this.db.credentials.set(key, {
        organization_id: organizationId,
        kind,
        ciphertext,
        dek_ciphertext: dekCiphertext,
        kek_version: kekVersion,
        updated_at: new Date().toISOString(),
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (/^DELETE FROM org_credentials/i.test(sql)) {
      const [organizationId, kind] = this.bindings as [string, string];
      const key = `${organizationId}|${kind}`;
      const had = this.db.credentials.has(key);
      this.db.credentials.delete(key);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    throw new Error(`FakeD1.run: unsupported SQL: ${sql}`);
  }

  async first<T>(): Promise<T | null> {
    const sql = normalizeSql(this.sql);

    if (/^SELECT .* FROM installations WHERE organization_id/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      return (this.db.installations.get(orgId) as unknown as T) ?? null;
    }

    if (/^SELECT .* FROM projects WHERE team_id/i.test(sql)) {
      const [teamId] = this.bindings as [string];
      return (this.db.projects.get(teamId) as unknown as T) ?? null;
    }

    if (/^SELECT .* FROM users\s+WHERE id =/i.test(sql)) {
      const [id] = this.bindings as [string];
      for (const user of this.db.users.values()) {
        if (user.id === id) return user as unknown as T;
      }
      return null;
    }

    if (
      /^SELECT .* FROM users\s+WHERE organization_id = \? AND linear_user_id/i.test(
        sql,
      )
    ) {
      const [organizationId, linearUserId] = this.bindings as [string, string];
      const key = `${organizationId}|${linearUserId}`;
      return (this.db.users.get(key) as unknown as T) ?? null;
    }

    if (
      /^SELECT .* FROM org_credentials\s+WHERE organization_id = \? AND kind =/i.test(
        sql,
      )
    ) {
      const [organizationId, kind] = this.bindings as [string, string];
      const key = `${organizationId}|${kind}`;
      return (this.db.credentials.get(key) as unknown as T) ?? null;
    }

    throw new Error(`FakeD1.first: unsupported SQL: ${sql}`);
  }

  async all<T>(): Promise<{ success: true; results: T[] }> {
    const sql = normalizeSql(this.sql);

    if (/^SELECT .* FROM installations LIMIT 2/i.test(sql)) {
      return {
        success: true,
        results: Array.from(this.db.installations.values()).slice(
          0,
          2,
        ) as unknown as T[],
      };
    }
    if (/^SELECT .* FROM installations ORDER BY installed_at/i.test(sql)) {
      return {
        success: true,
        results: Array.from(this.db.installations.values()) as unknown as T[],
      };
    }
    if (/^SELECT .* FROM projects ORDER BY team_id/i.test(sql) && this.bindings.length === 0) {
      return {
        success: true,
        results: Array.from(this.db.projects.values()) as unknown as T[],
      };
    }
    if (
      /^SELECT .* FROM projects WHERE organization_id = \? ORDER BY team_id/i.test(sql)
    ) {
      const [organizationId] = this.bindings as [string];
      const filtered = Array.from(this.db.projects.values()).filter(
        (p) => p.organization_id === organizationId,
      );
      return { success: true, results: filtered as unknown as T[] };
    }
    if (/^SELECT kind FROM org_credentials WHERE organization_id/i.test(sql)) {
      const [organizationId] = this.bindings as [string];
      const kinds = Array.from(this.db.credentials.values())
        .filter((c) => c.organization_id === organizationId)
        .map((c) => ({ kind: c.kind }))
        .sort((a, b) => a.kind.localeCompare(b.kind));
      return { success: true, results: kinds as unknown as T[] };
    }
    throw new Error(`FakeD1.all: unsupported SQL: ${sql}`);
  }
}

/**
 * Collapse newlines + extra whitespace so the multi-line prepared SQL
 * strings in `src/lib/store.ts` match the single-line regexes above.
 * D1 itself ignores whitespace; this is purely a test-side
 * convenience.
 */
function normalizeSql(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}
