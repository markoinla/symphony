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

let nextInstallId = 1;
let nextProjectId = 1;

export class FakeD1 {
  installations = new Map<string, InstallationRow>();
  projects = new Map<string, ProjectRow>();

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
        installed_at: existing?.installed_at ?? now,
        refreshed_at: now,
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
    throw new Error(`FakeD1.all: unsupported SQL: ${sql}`);
  }
}

function normalizeSql(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}
