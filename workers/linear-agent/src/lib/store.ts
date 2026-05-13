/**
 * D1-backed repositories for the linear-agent Worker.
 *
 * Every domain table is tenanted by Better Auth's `organizations.id`.
 * The `linear_agent_installs` table additionally carries the Linear
 * platform's `organizationId` so webhook deliveries can be routed to
 * the correct tenant.
 *
 * Tables (see migrations/0001_init.sql):
 *   - linear_agent_installs  — per-org Linear Agent install token.
 *   - github_installs        — per-org Symphony GitHub App install.
 *   - projects               — per-Linear-team project config.
 *   - agent_sessions         — agent run records (debug payload).
 *
 * Better Auth tables (`users`, `sessions`, `accounts`, `organizations`,
 * `members`, `invitations`, `teams`, `teamMembers`, `verifications`)
 * are owned by the Better Auth Drizzle adapter — do not write to them
 * directly here.
 */

// ── linear_agent_installs ───────────────────────────────────────────

export interface LinearAgentInstallRecord {
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
  // Unix seconds when the current access_token expires. NULL on rows
  // installed before migration 0006 or when Linear's token response
  // omitted `expires_in`. NULL signals "unknown — refresh on next use".
  expires_at: number | null;
}

export class LinearAgentInstallStore {
  constructor(private readonly db: D1Database) {}

  private static readonly COLUMNS =
    "id, organization_id, linear_organization_id, access_token, refresh_token, scopes, installed_by_user_id, status, installed_at, refreshed_at, expires_at";

  async upsert(input: {
    organizationId: string;
    linearOrganizationId: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: number | null;
    scopes: string;
    installedByUserId: string;
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .prepare(
        `INSERT INTO linear_agent_installs
           (id, organization_id, linear_organization_id, access_token, refresh_token,
            scopes, installed_by_user_id, status, installed_at, refreshed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(linear_organization_id) DO UPDATE SET
           organization_id      = excluded.organization_id,
           access_token         = excluded.access_token,
           refresh_token        = excluded.refresh_token,
           scopes               = excluded.scopes,
           installed_by_user_id = excluded.installed_by_user_id,
           status               = 'active',
           refreshed_at         = excluded.refreshed_at,
           expires_at           = excluded.expires_at`,
      )
      .bind(
        crypto.randomUUID(),
        input.organizationId,
        input.linearOrganizationId,
        input.accessToken,
        input.refreshToken ?? null,
        input.scopes,
        input.installedByUserId,
        now,
        now,
        input.expiresAt ?? null,
      )
      .run();
  }

  async getByLinearOrgId(
    linearOrgId: string,
  ): Promise<LinearAgentInstallRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${LinearAgentInstallStore.COLUMNS}
         FROM linear_agent_installs WHERE linear_organization_id = ?`,
      )
      .bind(linearOrgId)
      .first<LinearAgentInstallRecord>();
  }

  async getByOrgId(orgId: string): Promise<LinearAgentInstallRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${LinearAgentInstallStore.COLUMNS}
         FROM linear_agent_installs WHERE organization_id = ?`,
      )
      .bind(orgId)
      .first<LinearAgentInstallRecord>();
  }

  async refreshToken(
    id: string,
    accessToken: string,
    refreshToken?: string | null,
    expiresAt?: number | null,
  ): Promise<void> {
    // Sentinel −1 lets us distinguish "caller passed undefined" (keep
    // existing expiry) from "caller passed null" (clear it explicitly).
    // SQLite has no NULL-vs-missing parameter; we encode it via COALESCE
    // against a sentinel binding the same way `refresh_token` works.
    const expiresArg = expiresAt === undefined ? null : expiresAt;
    const preserveExpires = expiresAt === undefined;
    await this.db
      .prepare(
        `UPDATE linear_agent_installs
         SET access_token = ?,
             refresh_token = COALESCE(?, refresh_token),
             refreshed_at = ?,
             expires_at = CASE WHEN ? THEN expires_at ELSE ? END,
             status = 'active'
         WHERE id = ?`,
      )
      .bind(
        accessToken,
        refreshToken ?? null,
        Math.floor(Date.now() / 1000),
        preserveExpires ? 1 : 0,
        expiresArg,
        id,
      )
      .run();
  }

  /**
   * Mark the install as needing user-driven reconnect (e.g. Linear's
   * refresh endpoint returned `invalid_grant`). Future refresh attempts
   * short-circuit on `status='reconnect_required'`, so this is sticky
   * until a fresh OAuth callback re-upserts the row with status='active'.
   */
  async markReconnectRequired(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_agent_installs
         SET status = 'reconnect_required'
         WHERE id = ?`,
      )
      .bind(id)
      .run();
  }

  async delete(orgId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM linear_agent_installs WHERE organization_id = ?")
      .bind(orgId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

// ── github_installs ─────────────────────────────────────────────────

export interface GitHubInstallRecord {
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

export class GitHubInstallStore {
  constructor(private readonly db: D1Database) {}

  private static readonly COLUMNS =
    "id, organization_id, install_id, account_login, account_type, repo_selection, selected_repos, created_at, updated_at";

  async upsert(input: {
    organizationId: string;
    installId: number;
    accountLogin: string;
    accountType?: string;
    repoSelection?: string;
    selectedRepos?: string[] | null;
  }): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .prepare(
        `INSERT INTO github_installs
           (id, organization_id, install_id, account_login, account_type, repo_selection, selected_repos, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(install_id) DO UPDATE SET
           organization_id = excluded.organization_id,
           account_login   = excluded.account_login,
           account_type    = excluded.account_type,
           repo_selection  = excluded.repo_selection,
           selected_repos  = excluded.selected_repos,
           updated_at      = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(),
        input.organizationId,
        input.installId,
        input.accountLogin,
        input.accountType ?? "Organization",
        input.repoSelection ?? "all",
        input.selectedRepos ? JSON.stringify(input.selectedRepos) : null,
        now,
        now,
      )
      .run();
  }

  async getByOrgId(orgId: string): Promise<GitHubInstallRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${GitHubInstallStore.COLUMNS}
         FROM github_installs WHERE organization_id = ?`,
      )
      .bind(orgId)
      .first<GitHubInstallRecord>();
  }

  async list(): Promise<GitHubInstallRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT ${GitHubInstallStore.COLUMNS}
         FROM github_installs ORDER BY created_at DESC`,
      )
      .all<GitHubInstallRecord>();
    return result.results;
  }

  async delete(orgId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM github_installs WHERE organization_id = ?")
      .bind(orgId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

// ── projects ───────────────────────────────────────────────────────

export interface ProjectRecord {
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

export class ProjectStore {
  constructor(private readonly db: D1Database) {}

  private static readonly COLUMNS =
    "id, organization_id, linear_team_id, linear_team_name, repo_url, default_branch, engine, model, max_turns, scope, system_prompt_override, created_at, updated_at";

  async upsert(input: {
    organizationId: string;
    linearTeamId: string;
    repoUrl: string;
    defaultBranch?: string;
    engine?: string;
    model?: string | null;
    maxTurns?: number;
    linearTeamName?: string;
    scope?: string | null;
    systemPromptOverride?: string | null;
  }): Promise<ProjectRecord | null> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, linear_team_id, linear_team_name, repo_url, default_branch,
            engine, model, max_turns, scope, system_prompt_override, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, linear_team_id) DO UPDATE SET
           linear_team_name       = excluded.linear_team_name,
           repo_url               = excluded.repo_url,
           default_branch         = excluded.default_branch,
           engine                 = excluded.engine,
           model                  = excluded.model,
           max_turns              = excluded.max_turns,
           scope                  = excluded.scope,
           system_prompt_override = excluded.system_prompt_override,
           updated_at             = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(),
        input.organizationId,
        input.linearTeamId,
        input.linearTeamName ?? "",
        input.repoUrl,
        input.defaultBranch ?? "main",
        input.engine ?? "pi",
        input.model ?? null,
        input.maxTurns ?? 10,
        input.scope ?? null,
        input.systemPromptOverride ?? null,
        now,
        now,
      )
      .run();
    return this.getByTeamId(input.organizationId, input.linearTeamId);
  }

  // Strict create — INSERT only, never upsert. Caller is responsible
  // for handling the unique-constraint violation (the v1 routes pre-check
  // via getByTeamId and return `conflict`). Used by `/api/v1/projects`;
  // the dashboard handler keeps `upsert()` for its existing UX flow.
  async create(input: {
    organizationId: string;
    linearTeamId: string;
    linearTeamName?: string;
    repoUrl: string;
    defaultBranch?: string;
    engine?: string;
    model?: string | null;
    maxTurns?: number;
    scope?: string | null;
    systemPromptOverride?: string | null;
  }): Promise<ProjectRecord | null> {
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, linear_team_id, linear_team_name, repo_url, default_branch,
            engine, model, max_turns, scope, system_prompt_override, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.organizationId,
        input.linearTeamId,
        input.linearTeamName ?? "",
        input.repoUrl,
        input.defaultBranch ?? "main",
        input.engine ?? "pi",
        input.model ?? null,
        input.maxTurns ?? 10,
        input.scope ?? null,
        input.systemPromptOverride ?? null,
        now,
        now,
      )
      .run();
    return this.getById(id, input.organizationId);
  }

  async getByTeamId(
    orgId: string,
    linearTeamId: string,
  ): Promise<ProjectRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${ProjectStore.COLUMNS}
         FROM projects WHERE organization_id = ? AND linear_team_id = ?`,
      )
      .bind(orgId, linearTeamId)
      .first<ProjectRecord>();
  }

  async getById(id: string, orgId: string): Promise<ProjectRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${ProjectStore.COLUMNS}
         FROM projects WHERE id = ? AND organization_id = ?`,
      )
      .bind(id, orgId)
      .first<ProjectRecord>();
  }

  async listByOrg(orgId: string): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT ${ProjectStore.COLUMNS}
         FROM projects WHERE organization_id = ? ORDER BY created_at DESC`,
      )
      .bind(orgId)
      .all<ProjectRecord>();
    return result.results;
  }

  async list(): Promise<ProjectRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT ${ProjectStore.COLUMNS}
         FROM projects ORDER BY organization_id, linear_team_id`,
      )
      .all<ProjectRecord>();
    return result.results;
  }

  async update(
    id: string,
    orgId: string,
    input: {
      linearTeamId?: string;
      linearTeamName?: string;
      repoUrl?: string;
      defaultBranch?: string;
      engine?: string;
      model?: string | null;
      maxTurns?: number;
      scope?: string | null;
      systemPromptOverride?: string | null;
    },
  ): Promise<ProjectRecord | null> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.linearTeamId !== undefined) {
      fields.push("linear_team_id = ?");
      values.push(input.linearTeamId);
    }
    if (input.linearTeamName !== undefined) {
      fields.push("linear_team_name = ?");
      values.push(input.linearTeamName);
    }
    if (input.repoUrl !== undefined) {
      fields.push("repo_url = ?");
      values.push(input.repoUrl);
    }
    if (input.defaultBranch !== undefined) {
      fields.push("default_branch = ?");
      values.push(input.defaultBranch);
    }
    if (input.engine !== undefined) {
      fields.push("engine = ?");
      values.push(input.engine);
    }
    if (input.model !== undefined) {
      fields.push("model = ?");
      values.push(input.model);
    }
    if (input.maxTurns !== undefined) {
      fields.push("max_turns = ?");
      values.push(input.maxTurns);
    }
    if (input.scope !== undefined) {
      fields.push("scope = ?");
      values.push(input.scope);
    }
    if (input.systemPromptOverride !== undefined) {
      fields.push("system_prompt_override = ?");
      values.push(input.systemPromptOverride);
    }

    if (fields.length === 0) return this.getById(id, orgId);

    fields.push("updated_at = ?");
    values.push(Math.floor(Date.now() / 1000));
    values.push(id, orgId);

    await this.db
      .prepare(
        `UPDATE projects SET ${fields.join(", ")}
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(...values)
      .run();

    return this.getById(id, orgId);
  }

  async delete(orgId: string, linearTeamId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "DELETE FROM projects WHERE organization_id = ? AND linear_team_id = ?",
      )
      .bind(orgId, linearTeamId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deleteById(id: string, orgId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM projects WHERE id = ? AND organization_id = ?")
      .bind(id, orgId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

// ── agent_sessions ──────────────────────────────────────────────────

export interface AgentSessionRecord {
  id: string;
  organization_id: string;
  project_id: string | null;
  linear_issue_id: string | null;
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

export interface AgentSessionListFilter {
  organizationId?: string;
  team?: string;
  repo?: string;
  status?: string;
  triggered_by?: string;
  limit?: number;
  offset?: number;
}

export class AgentSessionStore {
  constructor(private readonly db: D1Database) {}

  private static readonly COLUMNS =
    "id, organization_id, project_id, linear_issue_id, linear_issue_title, status, started_at, completed_at, triggered_by, team, repo, prompt, config_snapshot, stderr, dispatcher_logs, messages, error";

  async create(input: {
    id: string;
    organizationId: string;
    projectId?: string | null;
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
        `INSERT INTO agent_sessions
           (id, organization_id, project_id, linear_issue_id, linear_issue_title,
            status, started_at, triggered_by, team, repo, prompt, config_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.organizationId,
        input.projectId ?? null,
        input.linearIssueId ?? null,
        input.linearIssueTitle ?? null,
        input.status ?? "running",
        Math.floor(Date.now() / 1000),
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
      completedAt?: number;
      error?: string | null;
      stderr?: string | null;
      dispatcherLogs?: string | null;
      messages?: string | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

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
      .prepare(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }

  async get(id: string): Promise<AgentSessionRecord | null> {
    return await this.db
      .prepare(
        `SELECT ${AgentSessionStore.COLUMNS}
         FROM agent_sessions WHERE id = ?`,
      )
      .bind(id)
      .first<AgentSessionRecord>();
  }

  async list(filter?: AgentSessionListFilter): Promise<AgentSessionRecord[]> {
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (filter?.organizationId) {
      conditions.push("organization_id = ?");
      values.push(filter.organizationId);
    }
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
        `SELECT ${AgentSessionStore.COLUMNS}
         FROM agent_sessions ${where}
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...values, limit, offset)
      .all<AgentSessionRecord>();
    return result.results;
  }

  async listRunning(orgId?: string): Promise<AgentSessionRecord[]> {
    if (orgId) {
      const result = await this.db
        .prepare(
          `SELECT ${AgentSessionStore.COLUMNS}
           FROM agent_sessions
           WHERE status = 'running' AND organization_id = ?
           ORDER BY started_at DESC`,
        )
        .bind(orgId)
        .all<AgentSessionRecord>();
      return result.results;
    }
    const result = await this.db
      .prepare(
        `SELECT ${AgentSessionStore.COLUMNS}
         FROM agent_sessions WHERE status = 'running'
         ORDER BY started_at DESC`,
      )
      .all<AgentSessionRecord>();
    return result.results;
  }
}

// ── agent_session_events ────────────────────────────────────────────

export interface AgentSessionEventRecord {
  id: number;
  session_id: string;
  turn: number;
  ts: number;
  type: string;
  body: string | null;
}

export interface AgentSessionEventInput {
  turn: number;
  ts: number;
  type: string;
  body: string | null;
}

export class AgentSessionEventStore {
  constructor(private readonly db: D1Database) {}

  // Single-row append. Kept narrow to a single ? marker template — the
  // streaming turn loop calls this on every event so a stable prepared
  // statement is friendlier to D1's planner than building a fresh
  // multi-row INSERT each time.
  async append(
    sessionId: string,
    input: AgentSessionEventInput,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_session_events (session_id, turn, ts, type, body)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(sessionId, input.turn, input.ts, input.type, input.body)
      .run();
  }

  // Batched flush. Callers that buffer events between Linear posts
  // should prefer this — it's a single round-trip per buffer instead
  // of one per event.
  async appendBatch(
    sessionId: string,
    inputs: AgentSessionEventInput[],
  ): Promise<void> {
    if (inputs.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO agent_session_events (session_id, turn, ts, type, body)
       VALUES (?, ?, ?, ?, ?)`,
    );
    await this.db.batch(
      inputs.map((e) =>
        stmt.bind(sessionId, e.turn, e.ts, e.type, e.body),
      ),
    );
  }

  async listBySessionId(
    sessionId: string,
  ): Promise<AgentSessionEventRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, session_id, turn, ts, type, body
         FROM agent_session_events
         WHERE session_id = ?
         ORDER BY id ASC`,
      )
      .bind(sessionId)
      .all<AgentSessionEventRecord>();
    return result.results;
  }

  async countBySessionId(sessionId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_session_events WHERE session_id = ?`,
      )
      .bind(sessionId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}

// ── webhook_events ──────────────────────────────────────────────────

export interface WebhookEventRecord {
  id: string;
  received_at: number;
  organization_id: string | null;
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

export interface WebhookEventListFilter {
  organizationId?: string;
  envelope?: string;
  dispatched_action?: string;
  limit?: number;
  offset?: number;
  // v1-only cursor pagination + extra filters. When `beforeId` is set,
  // the resolver fetches that row's received_at and uses tuple
  // comparison `(received_at, id) < (?, ?)` to paginate. Mutually
  // exclusive with `offset` — callers should pick one mode.
  beforeId?: string;
  signatureOk?: boolean;
  deduped?: boolean;
  sinceTs?: number;
}

const WEBHOOK_EVENT_COLS =
  "id, received_at, organization_id, webhook_id, envelope_type, envelope_action, signature_ok, deduped, matched_workflow_id, matched_trigger_id, dispatched_action, agent_session_id, error, latency_ms, event_summary, raw_body";

export class WebhookEventStore {
  constructor(private readonly db: D1Database) {}

  async insert(input: {
    receivedAt: number;
    organizationId?: string | null;
    webhookId?: string | null;
    envelopeType: string;
    envelopeAction?: string | null;
    signatureOk: boolean;
    rawBody?: string | null;
    eventSummary?: string | null;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO webhook_events
           (id, received_at, organization_id, webhook_id, envelope_type, envelope_action,
            signature_ok, deduped, matched_workflow_id, matched_trigger_id,
            dispatched_action, agent_session_id, error, latency_ms, event_summary, raw_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 'pending', NULL, NULL, 0, ?, ?)`,
      )
      .bind(
        id,
        input.receivedAt,
        input.organizationId ?? null,
        input.webhookId ?? null,
        input.envelopeType,
        input.envelopeAction ?? null,
        input.signatureOk ? 1 : 0,
        input.eventSummary ?? null,
        input.rawBody ?? null,
      )
      .run();
    return id;
  }

  async update(
    id: string,
    fields: {
      organizationId?: string | null;
      deduped?: boolean;
      matchedWorkflowId?: string | null;
      matchedTriggerId?: string | null;
      dispatchedAction?: string;
      agentSessionId?: string | null;
      error?: string | null;
      latencyMs?: number;
      eventSummary?: string | null;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (fields.organizationId !== undefined) {
      sets.push("organization_id = ?");
      values.push(fields.organizationId);
    }
    if (fields.deduped !== undefined) {
      sets.push("deduped = ?");
      values.push(fields.deduped ? 1 : 0);
    }
    if (fields.matchedWorkflowId !== undefined) {
      sets.push("matched_workflow_id = ?");
      values.push(fields.matchedWorkflowId);
    }
    if (fields.matchedTriggerId !== undefined) {
      sets.push("matched_trigger_id = ?");
      values.push(fields.matchedTriggerId);
    }
    if (fields.dispatchedAction !== undefined) {
      sets.push("dispatched_action = ?");
      values.push(fields.dispatchedAction);
    }
    if (fields.agentSessionId !== undefined) {
      sets.push("agent_session_id = ?");
      values.push(fields.agentSessionId);
    }
    if (fields.error !== undefined) {
      sets.push("error = ?");
      values.push(fields.error);
    }
    if (fields.latencyMs !== undefined) {
      sets.push("latency_ms = ?");
      values.push(fields.latencyMs);
    }
    if (fields.eventSummary !== undefined) {
      sets.push("event_summary = ?");
      values.push(fields.eventSummary);
    }

    if (sets.length === 0) return;

    await this.db
      .prepare(`UPDATE webhook_events SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }

  async get(id: string, orgId?: string): Promise<WebhookEventRecord | null> {
    if (orgId) {
      return await this.db
        .prepare(
          `SELECT ${WEBHOOK_EVENT_COLS}
           FROM webhook_events WHERE id = ? AND organization_id = ?`,
        )
        .bind(id, orgId)
        .first<WebhookEventRecord>();
    }
    return await this.db
      .prepare(
        `SELECT ${WEBHOOK_EVENT_COLS}
         FROM webhook_events WHERE id = ?`,
      )
      .bind(id)
      .first<WebhookEventRecord>();
  }

  async list(filter: WebhookEventListFilter): Promise<WebhookEventRecord[]> {
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    if (filter.organizationId) {
      conditions.push("organization_id = ?");
      values.push(filter.organizationId);
    }
    if (filter.envelope) {
      conditions.push("envelope_type = ?");
      values.push(filter.envelope);
    }
    if (filter.dispatched_action) {
      conditions.push("dispatched_action = ?");
      values.push(filter.dispatched_action);
    }
    if (filter.signatureOk !== undefined) {
      conditions.push("signature_ok = ?");
      values.push(filter.signatureOk ? 1 : 0);
    }
    if (filter.deduped !== undefined) {
      conditions.push("deduped = ?");
      values.push(filter.deduped ? 1 : 0);
    }
    if (filter.sinceTs !== undefined) {
      conditions.push("received_at >= ?");
      values.push(filter.sinceTs);
    }

    // Cursor pagination: pre-fetch the anchor's received_at to drive the
    // tuple comparison. Anchor missing from this org → treat as no cursor.
    if (filter.beforeId) {
      const anchor = await this.db
        .prepare(
          filter.organizationId
            ? "SELECT received_at FROM webhook_events WHERE id = ? AND organization_id = ?"
            : "SELECT received_at FROM webhook_events WHERE id = ?",
        )
        .bind(
          ...(filter.organizationId
            ? [filter.beforeId, filter.organizationId]
            : [filter.beforeId]),
        )
        .first<{ received_at: number }>();
      if (anchor) {
        conditions.push("(received_at, id) < (?, ?)");
        values.push(anchor.received_at, filter.beforeId);
      }
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 50, 200);

    // Cursor mode skips OFFSET — it's pure tuple-comparison ordering.
    if (filter.beforeId !== undefined) {
      const result = await this.db
        .prepare(
          `SELECT ${WEBHOOK_EVENT_COLS}
           FROM webhook_events ${where}
           ORDER BY received_at DESC, id DESC
           LIMIT ?`,
        )
        .bind(...values, limit)
        .all<WebhookEventRecord>();
      return result.results;
    }

    const offset = filter.offset ?? 0;
    const result = await this.db
      .prepare(
        `SELECT ${WEBHOOK_EVENT_COLS}
         FROM webhook_events ${where}
         ORDER BY received_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...values, limit, offset)
      .all<WebhookEventRecord>();
    return result.results;
  }
}

// ── settings ────────────────────────────────────────────────────────

export interface SettingRecord {
  key: string;
  value: string;
}

export class SettingStore {
  constructor(private readonly db: D1Database) {}

  async list(orgId: string): Promise<SettingRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT key, value FROM settings
         WHERE organization_id = ? ORDER BY key ASC`,
      )
      .bind(orgId)
      .all<SettingRecord>();
    return result.results;
  }

  async get(orgId: string, key: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT value FROM settings
         WHERE organization_id = ? AND key = ?`,
      )
      .bind(orgId, key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async upsert(orgId: string, key: string, value: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db
      .prepare(
        `INSERT INTO settings (id, organization_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, key) DO UPDATE SET
           value      = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .bind(crypto.randomUUID(), orgId, key, value, now, now)
      .run();
  }

  async delete(orgId: string, key: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM settings WHERE organization_id = ? AND key = ?`,
      )
      .bind(orgId, key)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

// ── Compatibility aliases ───────────────────────────────────────────
// Old names from the v1 schema. Existing callers can keep importing
// `InstallationStore` and get the new linear_agent_installs-backed
// implementation. Migrate at leisure.

export { LinearAgentInstallStore as InstallationStore };
export type { LinearAgentInstallRecord as InstallationRecord };
