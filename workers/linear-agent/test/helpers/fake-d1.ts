/**
 * Minimal D1Database stub for unit tests. Supports the subset of SQL
 * the linear-agent worker uses against the v2 schema
 * (migrations/0001_init.sql):
 *
 *   - linear_agent_installs (alias-keyed by both `organization_id`
 *     and `linear_organization_id`)
 *   - github_installs
 *   - projects (UUID `id`, composite key (organization_id, linear_team_id))
 *   - agent_sessions
 *   - org_credentials (BLOB ciphertext as ArrayBuffer)
 *
 * Better Auth's tables (`users`, `sessions`, `accounts`, `organizations`,
 * `members`, etc.) are owned by Better Auth itself and not exercised by
 * the stores under test — they're not modeled here.
 *
 * Column names mirror the migration exactly:
 *   - org foreign keys are `organization_id` (NOT `org_id`)
 *   - timestamps are INTEGER unix seconds (NOT ISO strings)
 *   - all primary keys are TEXT UUIDs
 */

export interface LinearAgentInstallRow {
  id: string;
  organization_id: string;
  linear_organization_id: string;
  access_token: string;
  refresh_token: string | null;
  scopes: string;
  installed_by_user_id: string;
  status: string;
  installed_at: number;
  refreshed_at: number;
  expires_at: number | null;
}

export interface ProjectRow {
  id: string;
  organization_id: string;
  linear_team_id: string;
  linear_team_name: string;
  repo_url: string;
  default_branch: string;
  engine: string;
  model: string | null;
  max_turns: number;
  scope: string | null;
  system_prompt_override: string | null;
  created_at: number;
  updated_at: number;
}

export interface OrgCredentialRow {
  id: string;
  organization_id: string;
  kind: string;
  ciphertext: ArrayBuffer;
  dek_ciphertext: ArrayBuffer;
  kek_version: number;
  created_at: number;
  updated_at: number;
}

export interface GitHubInstallRow {
  id: string;
  organization_id: string;
  install_id: number;
  account_login: string;
  account_type: string;
  repo_selection: string;
  selected_repos: string | null;
  created_at: number;
  updated_at: number;
}

export interface WebhookSourceRow {
  id: string;
  organization_id: string;
  kind: string;
  name: string;
  secret: string;
  config: string | null;
  created_at: number;
  updated_at: number;
}

export interface WebhookEventRow {
  id: string;
  received_at: number;
  organization_id: string | null;
  source_id: string | null;
  webhook_id: string | null;
  envelope_type: string;
  envelope_action: string | null;
  signature_ok: number;
  deduped: number;
  matched_workflow_id: string | null;
  matched_trigger_id: string | null;
  dispatched_action: string;
  agent_session_id: string | null;
  error: string | null;
  latency_ms: number;
  event_summary: string | null;
  raw_body: string | null;
}

export interface AgentSessionRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  linear_issue_id: string | null;
  linear_issue_identifier: string | null;
  linear_issue_title: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
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

export interface SettingRow {
  id: string;
  organization_id: string;
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

export class FakeD1 {
  // Keyed by `organization_id` for getByOrgId convenience, but we also
  // scan for getByLinearOrgId.
  linearAgentInstalls = new Map<string, LinearAgentInstallRow>();
  // Keyed by `${organization_id}:${linear_team_id}` for composite-key
  // tests; scan to look up by primary id.
  projects = new Map<string, ProjectRow>();
  orgCredentials = new Map<string, OrgCredentialRow>();
  githubInstalls = new Map<string, GitHubInstallRow>();
  agentSessions = new Map<string, AgentSessionRow>();
  webhookSources = new Map<string, WebhookSourceRow>();
  webhookEvents = new Map<string, WebhookEventRow>();
  // Keyed by `${organization_id}:${key}`.
  settings = new Map<string, SettingRow>();

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

  // Drizzle's D1 session calls `.raw()` on prepared selects when it
  // wants row tuples (arrays of values) instead of column-keyed
  // objects. We only need to support the `accounts JOIN members` query
  // issued by resolveLinearMcpToken; everything else is unused.
  async raw(): Promise<unknown[][]> {
    const sql = normalizeSql(this.sql);
    if (/from "accounts"/i.test(sql) || /from accounts/i.test(sql)) {
      return [];
    }
    throw new Error(`FakeD1.raw: unsupported SQL: ${sql}`);
  }

  async run() {
    const sql = normalizeSql(this.sql);

    // ── linear_agent_installs ───────────────────────────────────
    if (/^INSERT INTO linear_agent_installs/i.test(sql)) {
      const [
        id,
        organizationId,
        linearOrganizationId,
        accessToken,
        refreshToken,
        scopes,
        installedByUserId,
        installedAt,
        refreshedAt,
        expiresAt,
      ] = this.bindings as [
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
        number,
        number,
        number | null,
      ];
      const existing = findInstallByLinearOrg(this.db, linearOrganizationId);
      const row: LinearAgentInstallRow = {
        id: existing?.id ?? id,
        organization_id: organizationId,
        linear_organization_id: linearOrganizationId,
        access_token: accessToken,
        refresh_token: refreshToken,
        scopes,
        installed_by_user_id: installedByUserId,
        status: "active",
        installed_at: existing?.installed_at ?? installedAt,
        refreshed_at: refreshedAt,
        expires_at: expiresAt ?? null,
      };
      // Map is keyed by organization_id for fast getByOrgId. Drop any
      // previous row that pointed at the same org but a different
      // linear org (org_id is unique by FK / data convention).
      if (existing) this.db.linearAgentInstalls.delete(existing.organization_id);
      this.db.linearAgentInstalls.set(organizationId, row);
      return { success: true, meta: { changes: 1 } };
    }
    if (/^UPDATE linear_agent_installs[\s\S]+expires_at\s*=\s*CASE/i.test(sql)) {
      // refreshToken(...) UPDATE — preserves expires_at when the
      // caller passed undefined (encoded as preserveExpires=1).
      const [
        accessToken,
        refreshTokenArg,
        refreshedAt,
        preserveExpires,
        expiresArg,
        id,
      ] = this.bindings as [
        string,
        string | null,
        number,
        number,
        number | null,
        string,
      ];
      for (const row of this.db.linearAgentInstalls.values()) {
        if (row.id === id) {
          row.access_token = accessToken;
          if (refreshTokenArg !== null) row.refresh_token = refreshTokenArg;
          row.refreshed_at = refreshedAt;
          if (preserveExpires !== 1) row.expires_at = expiresArg;
          row.status = "active";
          return { success: true, meta: { changes: 1 } };
        }
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (/^UPDATE linear_agent_installs[\s\S]+status\s*=\s*'reconnect_required'/i.test(sql)) {
      const [id] = this.bindings as [string];
      for (const row of this.db.linearAgentInstalls.values()) {
        if (row.id === id) {
          row.status = "reconnect_required";
          return { success: true, meta: { changes: 1 } };
        }
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (/^DELETE FROM linear_agent_installs/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const had = this.db.linearAgentInstalls.has(orgId);
      this.db.linearAgentInstalls.delete(orgId);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    // ── projects ────────────────────────────────────────────────
    if (/^INSERT INTO projects/i.test(sql)) {
      const [
        id,
        organizationId,
        linearTeamId,
        linearTeamName,
        repoUrl,
        defaultBranch,
        engine,
        model,
        maxTurns,
        scope,
        systemPromptOverride,
        createdAt,
        updatedAt,
      ] = this.bindings as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        number,
        string | null,
        string | null,
        number,
        number,
      ];
      const key = `${organizationId}:${linearTeamId}`;
      const existing = this.db.projects.get(key);
      this.db.projects.set(key, {
        id: existing?.id ?? id,
        organization_id: organizationId,
        linear_team_id: linearTeamId,
        linear_team_name: linearTeamName,
        repo_url: repoUrl,
        default_branch: defaultBranch,
        engine,
        model,
        max_turns: maxTurns,
        scope,
        system_prompt_override: systemPromptOverride,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^UPDATE projects SET/i.test(sql)) {
      // Generic UPDATE projects ... WHERE id = ? AND organization_id = ?
      // The last two bindings are id, organizationId.
      const values = this.bindings.slice();
      const orgId = values.pop() as string;
      const id = values.pop() as string;
      const target = findProjectById(this.db, id, orgId);
      if (!target) return { success: true, meta: { changes: 0 } };
      // Parse the SET clauses to know which columns map to which
      // positional bindings. The store builds them in the same order
      // it appends to `values`, so we walk the captured ?-clauses and
      // pull from `values`.
      const setClause = sql
        .replace(/^UPDATE projects SET\s*/i, "")
        .replace(/\s*WHERE.*$/i, "");
      const assignments = setClause.split(",").map((c) => c.trim());
      for (const assign of assignments) {
        const [colRaw] = assign.split("=");
        const col = colRaw?.trim();
        const value = values.shift();
        if (!col) continue;
        applyProjectColumn(target, col, value);
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM projects WHERE id = \? AND organization_id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      for (const [key, row] of this.db.projects.entries()) {
        if (row.id === id && row.organization_id === orgId) {
          this.db.projects.delete(key);
          return { success: true, meta: { changes: 1 } };
        }
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (/^DELETE FROM projects/i.test(sql)) {
      const [orgId, linearTeamId] = this.bindings as [string, string];
      const key = `${orgId}:${linearTeamId}`;
      const had = this.db.projects.has(key);
      this.db.projects.delete(key);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    // ── org_credentials ─────────────────────────────────────────
    if (/^INSERT INTO org_credentials/i.test(sql)) {
      const [id, organizationId, kind, ciphertext, dekCiphertext, kekVersion, createdAt, updatedAt] =
        this.bindings as [
          string,
          string,
          string,
          ArrayBuffer,
          ArrayBuffer,
          number,
          number,
          number,
        ];
      const key = `${organizationId}:${kind}`;
      const existing = this.db.orgCredentials.get(key);
      this.db.orgCredentials.set(key, {
        id: existing?.id ?? id,
        organization_id: organizationId,
        kind,
        ciphertext,
        dek_ciphertext: dekCiphertext,
        kek_version: kekVersion,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
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

    // ── github_installs ─────────────────────────────────────────
    if (/^INSERT INTO github_installs/i.test(sql)) {
      const [id, organizationId, installId, accountLogin, accountType, repoSelection, selectedRepos, createdAt, updatedAt] =
        this.bindings as [
          string,
          string,
          number,
          string,
          string,
          string,
          string | null,
          number,
          number,
        ];
      // Key on organization_id so getByOrgId is O(1). Drop any prior
      // row with the same install_id under a different org.
      for (const [key, row] of this.db.githubInstalls.entries()) {
        if (row.install_id === installId && key !== organizationId) {
          this.db.githubInstalls.delete(key);
        }
      }
      const existing = this.db.githubInstalls.get(organizationId);
      this.db.githubInstalls.set(organizationId, {
        id: existing?.id ?? id,
        organization_id: organizationId,
        install_id: installId,
        account_login: accountLogin,
        account_type: accountType,
        repo_selection: repoSelection,
        selected_repos: selectedRepos,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM github_installs/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const had = this.db.githubInstalls.has(orgId);
      this.db.githubInstalls.delete(orgId);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    // ── agent_sessions ──────────────────────────────────────────
    if (/^INSERT INTO agent_sessions/i.test(sql)) {
      const [
        id,
        organizationId,
        projectId,
        linearIssueId,
        linearIssueIdentifier,
        linearIssueTitle,
        status,
        startedAt,
        triggeredBy,
        team,
        repo,
        prompt,
        configSnapshot,
      ] = this.bindings as [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      this.db.agentSessions.set(id, {
        id,
        organization_id: organizationId,
        project_id: projectId,
        linear_issue_id: linearIssueId,
        linear_issue_identifier: linearIssueIdentifier,
        linear_issue_title: linearIssueTitle,
        status,
        started_at: startedAt,
        completed_at: null,
        triggered_by: triggeredBy,
        team,
        repo,
        prompt,
        config_snapshot: configSnapshot,
        stderr: null,
        dispatcher_logs: null,
        messages: null,
        error: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    // ── webhook_sources ────────────────────────────────────────
    if (/^INSERT INTO webhook_sources/i.test(sql)) {
      const [id, organizationId, kind, name, secret, config, createdAt, updatedAt] =
        this.bindings as [string, string, string, string, string, string | null, number, number];
      this.db.webhookSources.set(id, {
        id,
        organization_id: organizationId,
        kind,
        name,
        secret,
        config,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^UPDATE webhook_sources SET/i.test(sql)) {
      const values = this.bindings.slice();
      const orgId = values.pop() as string;
      const id = values.pop() as string;
      const row = this.db.webhookSources.get(id);
      if (!row || row.organization_id !== orgId) return { success: true, meta: { changes: 0 } };
      const setClause = sql.replace(/^UPDATE webhook_sources SET\s*/i, "").replace(/\s*WHERE.*$/i, "");
      for (const assign of setClause.split(",").map((c) => c.trim())) {
        const [colRaw] = assign.split("=");
        const col = colRaw?.trim();
        const value = values.shift();
        if (col === "name") row.name = value as string;
        if (col === "config") row.config = (value ?? null) as string | null;
        if (col === "secret") row.secret = value as string;
        if (col === "updated_at") row.updated_at = value as number;
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM webhook_sources/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.webhookSources.get(id);
      const removed = !!row && row.organization_id === orgId && this.db.webhookSources.delete(id);
      return { success: true, meta: { changes: removed ? 1 : 0 } };
    }

    // ── webhook_events ──────────────────────────────────────────
    if (/^INSERT INTO webhook_events/i.test(sql)) {
      const [
        id,
        receivedAt,
        organizationId,
        sourceId,
        webhookId,
        envelopeType,
        envelopeAction,
        signatureOk,
        eventSummary,
        rawBody,
      ] = this.bindings as [
        string,
        number,
        string | null,
        string | null,
        string | null,
        string,
        string | null,
        number,
        string | null,
        string | null,
      ];
      this.db.webhookEvents.set(id, {
        id,
        received_at: receivedAt,
        organization_id: organizationId,
        source_id: sourceId,
        webhook_id: webhookId,
        envelope_type: envelopeType,
        envelope_action: envelopeAction,
        signature_ok: signatureOk,
        deduped: 0,
        matched_workflow_id: null,
        matched_trigger_id: null,
        dispatched_action: "pending",
        agent_session_id: null,
        error: null,
        latency_ms: 0,
        event_summary: eventSummary,
        raw_body: rawBody,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^UPDATE webhook_events SET/i.test(sql)) {
      const values = this.bindings.slice();
      const id = values.pop() as string;
      const row = this.db.webhookEvents.get(id);
      if (!row) return { success: true, meta: { changes: 0 } };
      const setClause = sql
        .replace(/^UPDATE webhook_events SET\s*/i, "")
        .replace(/\s*WHERE.*$/i, "");
      const assignments = setClause.split(",").map((c) => c.trim());
      for (const assign of assignments) {
        const [colRaw] = assign.split("=");
        const col = colRaw?.trim();
        const value = values.shift();
        if (!col) continue;
        applyWebhookEventColumn(row, col, value);
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (/^UPDATE agent_sessions SET/i.test(sql)) {
      const values = this.bindings.slice();
      const id = values.pop() as string;
      const row = this.db.agentSessions.get(id);
      if (!row) return { success: true, meta: { changes: 0 } };
      const setClause = sql
        .replace(/^UPDATE agent_sessions SET\s*/i, "")
        .replace(/\s*WHERE.*$/i, "");
      const assignments = setClause.split(",").map((c) => c.trim());
      for (const assign of assignments) {
        const [colRaw] = assign.split("=");
        const col = colRaw?.trim();
        const value = values.shift();
        if (!col) continue;
        applyAgentSessionColumn(row, col, value);
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (/^INSERT INTO settings/i.test(sql)) {
      const [id, organization_id, key, value, created_at, updated_at] =
        this.bindings as [string, string, string, string, number, number];
      const k = `${organization_id}:${key}`;
      const existing = this.db.settings.get(k);
      if (existing) {
        // ON CONFLICT(organization_id, key) DO UPDATE
        existing.value = value;
        existing.updated_at = updated_at;
      } else {
        this.db.settings.set(k, {
          id,
          organization_id,
          key,
          value,
          created_at,
          updated_at,
        });
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (/^DELETE FROM settings/i.test(sql)) {
      const [orgId, key] = this.bindings as [string, string];
      const k = `${orgId}:${key}`;
      const had = this.db.settings.delete(k);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    throw new Error(`FakeD1.run: unsupported SQL: ${sql}`);
  }

  async first<T>(): Promise<T | null> {
    const sql = normalizeSql(this.sql);

    if (/FROM linear_agent_installs WHERE linear_organization_id/i.test(sql)) {
      const [linearOrgId] = this.bindings as [string];
      return (findInstallByLinearOrg(this.db, linearOrgId) as unknown as T) ?? null;
    }
    if (/FROM linear_agent_installs WHERE organization_id/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      return (this.db.linearAgentInstalls.get(orgId) as unknown as T) ?? null;
    }

    if (/FROM projects WHERE organization_id = \? AND linear_team_id/i.test(sql)) {
      const [orgId, linearTeamId] = this.bindings as [string, string];
      const key = `${orgId}:${linearTeamId}`;
      return (this.db.projects.get(key) as unknown as T) ?? null;
    }
    if (/FROM projects WHERE id = \? AND organization_id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      return (findProjectById(this.db, id, orgId) as unknown as T) ?? null;
    }

    if (/FROM org_credentials WHERE organization_id = \? AND kind/i.test(sql)) {
      const [orgId, kind] = this.bindings as [string, string];
      const key = `${orgId}:${kind}`;
      return (this.db.orgCredentials.get(key) as unknown as T) ?? null;
    }

    if (/FROM github_installs WHERE organization_id/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      return (this.db.githubInstalls.get(orgId) as unknown as T) ?? null;
    }

    if (/FROM webhook_sources WHERE id = \? AND organization_id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.webhookSources.get(id);
      return (row && row.organization_id === orgId ? (row as unknown as T) : null);
    }
    if (/FROM webhook_sources WHERE id = \?/i.test(sql)) {
      const [id] = this.bindings as [string];
      return (this.db.webhookSources.get(id) as unknown as T) ?? null;
    }

    if (/FROM webhook_events WHERE id = \? AND organization_id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.webhookEvents.get(id);
      return (row && row.organization_id === orgId ? (row as unknown as T) : null);
    }
    if (/FROM webhook_events WHERE id = \?/i.test(sql)) {
      const [id] = this.bindings as [string];
      return (this.db.webhookEvents.get(id) as unknown as T) ?? null;
    }

    if (/FROM agent_sessions WHERE id/i.test(sql)) {
      const [id] = this.bindings as [string];
      return (this.db.agentSessions.get(id) as unknown as T) ?? null;
    }

    if (/^SELECT value FROM settings/i.test(sql)) {
      const [orgId, key] = this.bindings as [string, string];
      const row = this.db.settings.get(`${orgId}:${key}`);
      return (row ? ({ value: row.value } as unknown as T) : null);
    }

    throw new Error(`FakeD1.first: unsupported SQL: ${sql}`);
  }

  async all<T>(): Promise<{ success: true; results: T[] }> {
    const sql = normalizeSql(this.sql);

    if (/FROM linear_agent_installs ORDER BY installed_at/i.test(sql)) {
      const rows = Array.from(this.db.linearAgentInstalls.values()).sort(
        (a, b) => b.installed_at - a.installed_at,
      );
      return { success: true, results: rows as unknown as T[] };
    }

    if (/FROM projects WHERE organization_id = \? ORDER BY created_at/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const rows = Array.from(this.db.projects.values()).filter(
        (r) => r.organization_id === orgId,
      );
      return { success: true, results: rows as unknown as T[] };
    }
    if (/FROM projects ORDER BY organization_id/i.test(sql)) {
      return {
        success: true,
        results: Array.from(this.db.projects.values()) as unknown as T[],
      };
    }

    if (/SELECT kind FROM org_credentials WHERE organization_id = \? ORDER BY kind/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const kinds = Array.from(this.db.orgCredentials.values())
        .filter((r) => r.organization_id === orgId)
        .map((r) => ({ kind: r.kind }))
        .sort((a, b) => a.kind.localeCompare(b.kind));
      return { success: true, results: kinds as unknown as T[] };
    }

    if (/FROM github_installs ORDER BY created_at/i.test(sql)) {
      return {
        success: true,
        results: Array.from(this.db.githubInstalls.values()) as unknown as T[],
      };
    }

    if (/FROM webhook_sources WHERE organization_id = \?/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const rows = [...this.db.webhookSources.values()]
        .filter((r) => r.organization_id === orgId)
        .sort((a, b) => b.created_at - a.created_at);
      return { success: true, results: rows as unknown as T[] };
    }

    if (/FROM webhook_events/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const rows = [...this.db.webhookEvents.values()]
        .filter((r) => !orgId || r.organization_id === orgId)
        .sort((a, b) => b.received_at - a.received_at);
      return { success: true, results: rows as unknown as T[] };
    }

    // Drizzle-issued queries against Better Auth's `accounts`/`members`
    // tables (used by resolveLinearMcpToken). Tests that exercise the
    // workflow don't seed these — we just return an empty result so
    // the resolver gracefully returns null.
    if (/from "accounts"/i.test(sql) || /from accounts/i.test(sql)) {
      return { success: true, results: [] as unknown as T[] };
    }

    if (/FROM agent_session_events/i.test(sql)) {
      return { success: true, results: [] as unknown as T[] };
    }

    if (/FROM agent_sessions/i.test(sql)) {
      // Strip trailing LIMIT ? OFFSET ? bindings if present.
      let bindings = this.bindings.slice();
      let limit: number | null = null;
      let offset = 0;
      if (/LIMIT \? OFFSET \?/i.test(sql)) {
        offset = (bindings.pop() as number) ?? 0;
        limit = (bindings.pop() as number) ?? null;
      }
      // Walk the WHERE clauses in order. Literal-equal clauses like
      // `status = 'running'` consume no binding; placeholder clauses
      // like `organization_id = ?` consume one. Everything else falls
      // through unmatched.
      const clauses = extractClauses(sql);
      let rows = Array.from(this.db.agentSessions.values());
      for (const { column, literal, hasPlaceholder } of clauses) {
        const value = hasPlaceholder ? bindings.shift() : literal;
        rows = rows.filter((r) => matchAgentSessionClause(r, column, value));
      }
      rows = rows.sort((a, b) => b.started_at - a.started_at);
      if (limit !== null) rows = rows.slice(offset, offset + limit);
      return { success: true, results: rows as unknown as T[] };
    }

    if (/^SELECT key, value FROM settings WHERE organization_id = \?/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const rows = [...this.db.settings.values()]
        .filter((r) => r.organization_id === orgId)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((r) => ({ key: r.key, value: r.value }));
      return { success: true, results: rows as unknown as T[] };
    }

    throw new Error(`FakeD1.all: unsupported SQL: ${sql}`);
  }
}

function findInstallByLinearOrg(
  db: FakeD1,
  linearOrgId: string,
): LinearAgentInstallRow | undefined {
  for (const row of db.linearAgentInstalls.values()) {
    if (row.linear_organization_id === linearOrgId) return row;
  }
  return undefined;
}

function findProjectById(
  db: FakeD1,
  id: string,
  orgId: string,
): ProjectRow | undefined {
  for (const row of db.projects.values()) {
    if (row.id === id && row.organization_id === orgId) return row;
  }
  return undefined;
}

function applyProjectColumn(row: ProjectRow, col: string, value: unknown): void {
  switch (col) {
    case "linear_team_id":
      row.linear_team_id = value as string;
      break;
    case "linear_team_name":
      row.linear_team_name = value as string;
      break;
    case "repo_url":
      row.repo_url = value as string;
      break;
    case "default_branch":
      row.default_branch = value as string;
      break;
    case "engine":
      row.engine = value as string;
      break;
    case "model":
      row.model = (value ?? null) as string | null;
      break;
    case "max_turns":
      row.max_turns = value as number;
      break;
    case "scope":
      row.scope = (value ?? null) as string | null;
      break;
    case "system_prompt_override":
      row.system_prompt_override = (value ?? null) as string | null;
      break;
    case "updated_at":
      row.updated_at = value as number;
      break;
  }
}

function applyWebhookEventColumn(
  row: WebhookEventRow,
  col: string,
  value: unknown,
): void {
  switch (col) {
    case "organization_id":
      row.organization_id = (value ?? null) as string | null;
      break;
    case "deduped":
      row.deduped = value as number;
      break;
    case "matched_workflow_id":
      row.matched_workflow_id = (value ?? null) as string | null;
      break;
    case "matched_trigger_id":
      row.matched_trigger_id = (value ?? null) as string | null;
      break;
    case "dispatched_action":
      row.dispatched_action = value as string;
      break;
    case "agent_session_id":
      row.agent_session_id = (value ?? null) as string | null;
      break;
    case "error":
      row.error = (value ?? null) as string | null;
      break;
    case "latency_ms":
      row.latency_ms = value as number;
      break;
    case "event_summary":
      row.event_summary = (value ?? null) as string | null;
      break;
  }
}

function applyAgentSessionColumn(
  row: AgentSessionRow,
  col: string,
  value: unknown,
): void {
  switch (col) {
    case "status":
      row.status = value as string;
      break;
    case "completed_at":
      row.completed_at = value as number;
      break;
    case "error":
      row.error = (value ?? null) as string | null;
      break;
    case "stderr":
      row.stderr = (value ?? null) as string | null;
      break;
    case "dispatcher_logs":
      row.dispatcher_logs = (value ?? null) as string | null;
      break;
    case "messages":
      row.messages = (value ?? null) as string | null;
      break;
  }
}

interface ParsedClause {
  column: string;
  literal: unknown;
  hasPlaceholder: boolean;
}

function extractClauses(sql: string): ParsedClause[] {
  const m = sql.match(/WHERE\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|$)/i);
  if (!m) return [];
  return m[1]!.split(/\s+AND\s+/i).map((raw) => {
    const trimmed = raw.trim();
    const parts = trimmed.split(/\s*=\s*/);
    const column = (parts[0] ?? "").trim();
    const rhs = (parts[1] ?? "").trim();
    if (rhs === "?") {
      return { column, literal: undefined, hasPlaceholder: true };
    }
    // Strip surrounding single quotes from literal values.
    const literal = rhs.replace(/^'|'$/g, "");
    return { column, literal, hasPlaceholder: false };
  });
}

function matchAgentSessionClause(
  row: AgentSessionRow,
  column: string,
  value: unknown,
): boolean {
  switch (column) {
    case "organization_id":
      return row.organization_id === value;
    case "team":
      return row.team === value;
    case "repo":
      return row.repo === value;
    case "status":
      return row.status === value;
    case "triggered_by":
      return row.triggered_by === value;
    default:
      return true;
  }
}

function normalizeSql(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}
