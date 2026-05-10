/**
 * Minimal D1Database stub for unit tests. Supports the subset of SQL
 * the linear-agent worker uses (item 3 schema): SELECT/INSERT/DELETE
 * against `installations` and `projects`. Anything else throws so
 * tests fail loudly when the worker grows new queries we haven't
 * stubbed.
 *
 * Keep this in lockstep with `src/lib/store.ts`. When you add a
 * query there, add it here.
 */

interface InstallationRow {
  organization_id: string;
  access_token: string;
  scopes: string;
  installed_at: string;
  refreshed_at: string;
}

interface ProjectRow {
  team_id: string;
  repo_url: string;
  default_branch: string;
  engine: string;
  model: string | null;
  max_turns: number;
  updated_at: string;
}

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
      const [orgId, token, scopes] = this.bindings as [string, string, string];
      const now = new Date().toISOString();
      this.db.installations.set(orgId, {
        organization_id: orgId,
        access_token: token,
        scopes,
        installed_at: this.db.installations.get(orgId)?.installed_at ?? now,
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
      const [teamId, repoUrl, defaultBranch, engine, model, maxTurns] =
        this.bindings as [string, string, string, string, string | null, number];
      this.db.projects.set(teamId, {
        team_id: teamId,
        repo_url: repoUrl,
        default_branch: defaultBranch,
        engine,
        model,
        max_turns: maxTurns,
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
    if (/^SELECT .* FROM projects ORDER BY team_id/i.test(sql)) {
      return {
        success: true,
        results: Array.from(this.db.projects.values()) as unknown as T[],
      };
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
