// /api/v1/* — REST surface + unified auth tests.
//
// `requireDashboardAuth` is mocked at module scope so positive auth
// cases don't need a live Better Auth + cookie jar. The bearer path is
// exercised against the real `tryBearerAuth` lookup, which falls
// through to D1 — `api_tokens` is empty until SYM-296, so every
// presented token returns 401.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above all imports, so referenced locals need to
// come from vi.hoisted (which is hoisted with it).
const { requireDashboardAuthMock } = vi.hoisted(() => {
  return { requireDashboardAuthMock: vi.fn() };
});

vi.mock("../src/lib/dashboard-auth", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/lib/dashboard-auth")
  >();
  return {
    ...actual,
    requireDashboardAuth: requireDashboardAuthMock,
  };
});

import { buildApp, type Env } from "../src/index";

// ── Minimal D1 mock that handles the SQL the /api/v1 routes emit ───

interface WorkflowRow {
  id: string;
  organization_id: string | null;
  team_id: string | null;
  user_id: string | null;
  name: string;
  description: string | null;
  engine: string;
  model: string | null;
  max_turns: number;
  max_continuations: number | null;
  allowed_tools: string | null;
  disallowed_tools: string | null;
  allowed_domains: string | null;
  mcp_servers: string | null;
  permission_mode: string | null;
  additional_read_paths: string | null;
  additional_write_paths: string | null;
  hook_after_create: string | null;
  hook_before_remove: string | null;
  hook_timeout_ms: number;
  prompt_template: string;
  version: number;
  status: string;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TriggerRow {
  id: string;
  workflow_id: string;
  event_type: string;
  to_state: string | null;
  from_state: string | null;
  label_name: string | null;
  comment_match: string | null;
  team_filter: string | null;
  project_filter: string | null;
  label_filter: string | null;
  skip_label_filter: string | null;
  assignee_filter: string | null;
  action: string;
  action_params: string | null;
  priority: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  id: string;
  workflow_id: string;
  version: number;
  snapshot: string;
  created_at: number;
}

interface ProjectRow {
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

class ApiD1 {
  workflows = new Map<string, WorkflowRow>();
  triggers = new Map<string, TriggerRow>();
  versions: VersionRow[] = [];
  projects = new Map<string, ProjectRow>();
  settings = new Map<string, { organization_id: string; key: string; value: string }>();
  webhookEvents: Array<{
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
  }> = [];
  apiTokens: Array<{
    id: string;
    organization_id: string;
    name: string;
    token_hash: string;
    scopes: string | null;
    created_at: number;
    last_used_at: number | null;
  }> = [];

  prepare(sql: string) {
    return new ApiStatement(this, sql);
  }
}

class ApiStatement {
  private bindings: unknown[] = [];
  constructor(private db: ApiD1, private sql: string) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async run() {
    const sql = norm(this.sql);

    if (/^INSERT INTO workflows/i.test(sql)) {
      // The route's INSERT has 21 placeholders. `team_id` and `user_id`
      // are literal NULL in the SQL on the POST path; the duplicate
      // route binds them explicitly. We detect by count.
      const b = this.bindings;
      const hasScopedColumns = b.length === 23;
      let idx = 0;
      const next = () => b[idx++];
      const id = next() as string;
      const organization_id = next() as string | null;
      const team_id = hasScopedColumns ? (next() as string | null) : null;
      const user_id = hasScopedColumns ? (next() as string | null) : null;
      const name = next() as string;
      const description = (next() ?? null) as string | null;
      const engine = next() as string;
      const model = (next() ?? null) as string | null;
      const max_turns = next() as number;
      const max_continuations = (next() ?? null) as number | null;
      const allowed_tools = (next() ?? null) as string | null;
      const disallowed_tools = (next() ?? null) as string | null;
      const allowed_domains = (next() ?? null) as string | null;
      const mcp_servers = (next() ?? null) as string | null;
      const permission_mode = (next() ?? null) as string | null;
      const additional_read_paths = (next() ?? null) as string | null;
      const additional_write_paths = (next() ?? null) as string | null;
      const hook_after_create = (next() ?? null) as string | null;
      const hook_before_remove = (next() ?? null) as string | null;
      const hook_timeout_ms = next() as number;
      const prompt_template = next() as string;
      const created_at = next() as number;
      const updated_at = next() as number;

      const row: WorkflowRow = {
        id,
        organization_id,
        team_id,
        user_id,
        name,
        description,
        engine,
        model,
        max_turns,
        max_continuations,
        allowed_tools,
        disallowed_tools,
        allowed_domains,
        mcp_servers,
        permission_mode,
        additional_read_paths,
        additional_write_paths,
        hook_after_create,
        hook_before_remove,
        hook_timeout_ms,
        prompt_template,
        version: 1,
        status: "draft",
        published_at: null,
        created_at,
        updated_at,
      };
      this.db.workflows.set(row.id, row);
      return { success: true, meta: { changes: 1 } };
    }

    if (/^UPDATE workflows SET/i.test(sql)) {
      // Two trailing positional bindings: id, organization_id.
      const values = this.bindings.slice();
      const orgId = values.pop() as string;
      const id = values.pop() as string;
      const row = this.db.workflows.get(id);
      if (!row || row.organization_id !== orgId)
        return { success: true, meta: { changes: 0 } };
      const setClause = sql
        .replace(/^UPDATE workflows SET\s*/i, "")
        .replace(/\s*WHERE.*$/i, "");
      const assignments = setClause.split(",").map((c) => c.trim());
      for (const assign of assignments) {
        const col = assign.split("=")[0]!.trim();
        // Non-placeholder expressions don't consume a binding —
        // either `version = version + 1` (no quote) or a string
        // literal like `status = 'published'`.
        if (!assign.includes("?")) {
          if (/^version\s*=\s*version\s*\+\s*1$/i.test(assign)) {
            row.version = row.version + 1;
          } else {
            const rhs = assign.split("=").slice(1).join("=").trim();
            const lit = rhs.replace(/^'|'$/g, "");
            applyWorkflowColumn(row, col, lit);
          }
          continue;
        }
        const v = values.shift();
        applyWorkflowColumn(row, col, v);
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (/^DELETE FROM workflows WHERE id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.workflows.get(id);
      if (row && row.organization_id === orgId) {
        this.db.workflows.delete(id);
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }

    if (/^INSERT INTO workflow_versions/i.test(sql)) {
      const [id, workflowId, version, snapshot, createdAt] = this
        .bindings as [string, string, number, string, number];
      this.db.versions.push({
        id,
        workflow_id: workflowId,
        version,
        snapshot,
        created_at: createdAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (/^INSERT INTO workflow_triggers/i.test(sql)) {
      const b = this.bindings;
      const row: TriggerRow = {
        id: b[0] as string,
        workflow_id: b[1] as string,
        event_type: b[2] as string,
        to_state: (b[3] ?? null) as string | null,
        from_state: (b[4] ?? null) as string | null,
        label_name: (b[5] ?? null) as string | null,
        comment_match: (b[6] ?? null) as string | null,
        team_filter: (b[7] ?? null) as string | null,
        project_filter: (b[8] ?? null) as string | null,
        label_filter: (b[9] ?? null) as string | null,
        skip_label_filter: (b[10] ?? null) as string | null,
        assignee_filter: (b[11] ?? null) as string | null,
        action: b[12] as string,
        action_params: (b[13] ?? null) as string | null,
        priority: b[14] as number,
        enabled: b[15] as number,
        created_at: b[16] as number,
        updated_at: b[17] as number,
      };
      this.db.triggers.set(row.id, row);
      return { success: true, meta: { changes: 1 } };
    }

    if (/^UPDATE workflow_triggers SET/i.test(sql)) {
      const values = this.bindings.slice();
      const id = values.pop() as string;
      const row = this.db.triggers.get(id);
      if (!row) return { success: true, meta: { changes: 0 } };
      const setClause = sql
        .replace(/^UPDATE workflow_triggers SET\s*/i, "")
        .replace(/\s*WHERE.*$/i, "");
      const assignments = setClause.split(",").map((c) => c.trim());
      for (const assign of assignments) {
        const col = assign.split("=")[0]!.trim();
        const v = values.shift();
        applyTriggerColumn(row, col, v);
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (/^DELETE FROM workflow_triggers/i.test(sql)) {
      const [id] = this.bindings as [string];
      const had = this.db.triggers.has(id);
      this.db.triggers.delete(id);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    if (/^INSERT INTO api_tokens/i.test(sql)) {
      const [id, organization_id, name, token_hash, scopes, created_at] = this
        .bindings as [string, string, string, string, string, number];
      this.db.apiTokens.push({
        id,
        organization_id,
        name,
        token_hash,
        scopes,
        created_at,
        last_used_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (/^UPDATE api_tokens SET last_used_at/i.test(sql)) {
      const [ts, id] = this.bindings as [number, string];
      const row = this.db.apiTokens.find((t) => t.id === id);
      if (!row) return { success: true, meta: { changes: 0 } };
      row.last_used_at = ts;
      return { success: true, meta: { changes: 1 } };
    }

    if (/^DELETE FROM api_tokens WHERE id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const idx = this.db.apiTokens.findIndex(
        (t) => t.id === id && t.organization_id === orgId,
      );
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      this.db.apiTokens.splice(idx, 1);
      return { success: true, meta: { changes: 1 } };
    }

    if (/^INSERT INTO projects/i.test(sql)) {
      const b = this.bindings as [
        string, string, string, string, string, string,
        string, string | null, number, string | null, string | null,
        number, number,
      ];
      const row: ProjectRow = {
        id: b[0],
        organization_id: b[1],
        linear_team_id: b[2],
        linear_team_name: b[3],
        repo_url: b[4],
        default_branch: b[5],
        engine: b[6],
        model: b[7],
        max_turns: b[8],
        scope: b[9],
        system_prompt_override: b[10],
        created_at: b[11],
        updated_at: b[12],
      };
      this.db.projects.set(row.id, row);
      return { success: true, meta: { changes: 1 } };
    }

    if (/^UPDATE projects SET/i.test(sql)) {
      const values = this.bindings.slice();
      const orgId = values.pop() as string;
      const id = values.pop() as string;
      const row = this.db.projects.get(id);
      if (!row || row.organization_id !== orgId)
        return { success: true, meta: { changes: 0 } };
      const setClause = sql
        .replace(/^UPDATE projects SET\s*/i, "")
        .replace(/\s*WHERE.*$/i, "");
      const assignments = setClause.split(",").map((c) => c.trim());
      for (const assign of assignments) {
        const col = assign.split("=")[0]!.trim();
        const v = values.shift();
        applyProjectColumn(row, col, v);
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (/^DELETE FROM projects WHERE id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.projects.get(id);
      if (!row || row.organization_id !== orgId)
        return { success: true, meta: { changes: 0 } };
      this.db.projects.delete(id);
      return { success: true, meta: { changes: 1 } };
    }

    if (/^INSERT INTO settings/i.test(sql)) {
      const [, orgId, key, value] = this.bindings as [
        string, string, string, string, number, number,
      ];
      this.db.settings.set(`${orgId}:${key}`, {
        organization_id: orgId,
        key,
        value,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (/^DELETE FROM settings/i.test(sql)) {
      const [orgId, key] = this.bindings as [string, string];
      const k = `${orgId}:${key}`;
      const had = this.db.settings.has(k);
      this.db.settings.delete(k);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    throw new Error(`ApiD1.run: unsupported SQL: ${sql}`);
  }

  async first<T>(): Promise<T | null> {
    const sql = norm(this.sql);

    if (/FROM workflows WHERE id = \? AND organization_id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.workflows.get(id);
      if (row && row.organization_id === orgId) return row as unknown as T;
      return null;
    }

    if (/FROM workflow_triggers WHERE id = \?$/i.test(sql)) {
      const [id] = this.bindings as [string];
      return (this.db.triggers.get(id) as unknown as T) ?? null;
    }

    if (
      /FROM workflow_triggers t JOIN workflows w/i.test(sql)
    ) {
      const [id, orgId] = this.bindings as [string, string];
      const t = this.db.triggers.get(id);
      if (!t) return null;
      const w = this.db.workflows.get(t.workflow_id);
      if (!w || w.organization_id !== orgId) return null;
      return t as unknown as T;
    }

    if (/FROM api_tokens WHERE token_hash/i.test(sql)) {
      const [hash] = this.bindings as [string];
      const row = this.db.apiTokens.find((t) => t.token_hash === hash);
      if (!row) return null;
      return row as unknown as T;
    }

    if (/FROM projects WHERE organization_id = \? AND linear_team_id/i.test(sql)) {
      const [orgId, teamId] = this.bindings as [string, string];
      const row = Array.from(this.db.projects.values()).find(
        (p) => p.organization_id === orgId && p.linear_team_id === teamId,
      );
      return (row as unknown as T) ?? null;
    }

    if (/FROM projects WHERE id = \? AND organization_id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.projects.get(id);
      if (!row || row.organization_id !== orgId) return null;
      return row as unknown as T;
    }

    if (/FROM settings\s+WHERE organization_id = \? AND key/i.test(sql)) {
      const [orgId, key] = this.bindings as [string, string];
      const row = this.db.settings.get(`${orgId}:${key}`);
      return row ? ({ value: row.value } as unknown as T) : null;
    }

    if (/FROM webhook_events WHERE id = \? AND organization_id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.webhookEvents.find(
        (e) => e.id === id && e.organization_id === orgId,
      );
      return (row as unknown as T) ?? null;
    }
    if (/SELECT received_at FROM webhook_events WHERE id = \? AND organization_id/i.test(sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.webhookEvents.find(
        (e) => e.id === id && e.organization_id === orgId,
      );
      return row ? ({ received_at: row.received_at } as unknown as T) : null;
    }

    if (/FROM linear_agent_installs WHERE organization_id/i.test(sql)) {
      // Tests don't seed these — return null so the integration handler
      // reports `connected: false`. Real integration coverage lives in
      // store.test.ts.
      return null;
    }
    if (/FROM github_installs WHERE organization_id/i.test(sql)) {
      return null;
    }

    throw new Error(`ApiD1.first: unsupported SQL: ${sql}`);
  }

  async all<T>(): Promise<{ success: true; results: T[] }> {
    const sql = norm(this.sql);

    if (/FROM workflows\s+WHERE .*\s+ORDER BY created_at/i.test(sql)) {
      // Cursor-paginated list. The handler emits:
      //   WHERE organization_id = ? [AND status = ?] [AND team_id = ?]
      //         [AND user_id = ?] [AND (created_at, id) < (?, ?)]
      //   ORDER BY created_at DESC, id DESC LIMIT ?
      const values = this.bindings.slice();
      // The final binding is always the LIMIT.
      const limit = values.pop() as number;
      const orgId = values.shift() as string;
      let status: string | undefined;
      let teamId: string | undefined;
      let userId: string | undefined;
      let cursorTs: number | undefined;
      let cursorId: string | undefined;
      if (/AND status = \?/i.test(sql)) status = values.shift() as string;
      if (/AND team_id = \?/i.test(sql)) teamId = values.shift() as string;
      if (/AND user_id = \?/i.test(sql)) userId = values.shift() as string;
      if (/\(created_at, id\) < \(\?, \?\)/i.test(sql)) {
        cursorTs = values.shift() as number;
        cursorId = values.shift() as string;
      }
      const rows = Array.from(this.db.workflows.values())
        .filter((w) => w.organization_id === orgId)
        .filter((w) => (status ? w.status === status : true))
        .filter((w) => (teamId ? w.team_id === teamId : true))
        .filter((w) => (userId ? w.user_id === userId : true))
        .filter((w) => {
          if (cursorTs === undefined || cursorId === undefined) return true;
          if (w.created_at < cursorTs) return true;
          if (w.created_at === cursorTs && w.id < cursorId) return true;
          return false;
        })
        .sort((a, b) =>
          b.created_at - a.created_at || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
        )
        .slice(0, limit);
      return { success: true, results: rows as unknown as T[] };
    }

    if (/FROM workflow_triggers WHERE workflow_id/i.test(sql)) {
      const [workflowId] = this.bindings as [string];
      const rows = Array.from(this.db.triggers.values())
        .filter((t) => t.workflow_id === workflowId)
        .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
      return { success: true, results: rows as unknown as T[] };
    }

    if (
      /FROM api_tokens WHERE organization_id = \? ORDER BY created_at/i.test(sql)
    ) {
      const [orgId] = this.bindings as [string];
      const rows = this.db.apiTokens
        .filter((t) => t.organization_id === orgId)
        .sort((a, b) => b.created_at - a.created_at);
      return { success: true, results: rows as unknown as T[] };
    }

    if (
      /FROM projects WHERE organization_id = \? ORDER BY created_at/i.test(sql)
    ) {
      const [orgId] = this.bindings as [string];
      const rows = Array.from(this.db.projects.values())
        .filter((p) => p.organization_id === orgId)
        .sort((a, b) => b.created_at - a.created_at);
      return { success: true, results: rows as unknown as T[] };
    }

    if (/FROM settings\s+WHERE organization_id = \? ORDER BY key/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const rows = Array.from(this.db.settings.values())
        .filter((s) => s.organization_id === orgId)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((s) => ({ key: s.key, value: s.value }));
      return { success: true, results: rows as unknown as T[] };
    }

    if (/FROM webhook_events/i.test(sql)) {
      // Both cursor mode (ORDER BY received_at DESC, id DESC LIMIT ?)
      // and offset mode (ORDER BY received_at DESC LIMIT ? OFFSET ?).
      const sqlNorm = sql;
      const cursorMode = /\(received_at, id\) < \(\?, \?\)/i.test(sqlNorm);
      const values = this.bindings.slice();

      // Limit / offset are the trailing bindings; everything before is
      // WHERE filters in the order they're appended in the store.
      let limit: number;
      let offset: number | null = null;
      if (cursorMode) {
        limit = values.pop() as number;
      } else {
        offset = values.pop() as number;
        limit = values.pop() as number;
      }

      // The store appends filters in this order, only when set:
      //   organization_id, envelope, dispatched_action, signature_ok,
      //   deduped, since_ts, then cursor (received_at, id).
      let orgId: string | undefined;
      let envelope: string | undefined;
      let dispatched: string | undefined;
      let signatureOk: 0 | 1 | undefined;
      let deduped: 0 | 1 | undefined;
      let sinceTs: number | undefined;
      let cursorTs: number | undefined;
      let cursorId: string | undefined;
      if (/organization_id = \?/i.test(sqlNorm)) orgId = values.shift() as string;
      if (/envelope_type = \?/i.test(sqlNorm)) envelope = values.shift() as string;
      if (/dispatched_action = \?/i.test(sqlNorm)) dispatched = values.shift() as string;
      if (/signature_ok = \?/i.test(sqlNorm)) signatureOk = values.shift() as 0 | 1;
      if (/deduped = \?/i.test(sqlNorm)) deduped = values.shift() as 0 | 1;
      if (/received_at >= \?/i.test(sqlNorm)) sinceTs = values.shift() as number;
      if (cursorMode) {
        cursorTs = values.shift() as number;
        cursorId = values.shift() as string;
      }

      const filtered = this.db.webhookEvents
        .filter((e) => (orgId ? e.organization_id === orgId : true))
        .filter((e) => (envelope ? e.envelope_type === envelope : true))
        .filter((e) => (dispatched ? e.dispatched_action === dispatched : true))
        .filter((e) => (signatureOk === undefined ? true : e.signature_ok === signatureOk))
        .filter((e) => (deduped === undefined ? true : e.deduped === deduped))
        .filter((e) => (sinceTs === undefined ? true : e.received_at >= sinceTs))
        .filter((e) => {
          if (cursorTs === undefined || cursorId === undefined) return true;
          if (e.received_at < cursorTs) return true;
          if (e.received_at === cursorTs && e.id < cursorId) return true;
          return false;
        })
        .sort((a, b) =>
          b.received_at - a.received_at ||
          (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
        );
      const sliced = cursorMode
        ? filtered.slice(0, limit)
        : filtered.slice(offset ?? 0, (offset ?? 0) + limit);
      return { success: true, results: sliced as unknown as T[] };
    }

    if (/FROM org_credentials WHERE organization_id/i.test(sql)) {
      // Same as the install rows — empty by default; real coverage in
      // credentials.test.ts.
      return { success: true, results: [] as unknown as T[] };
    }

    throw new Error(`ApiD1.all: unsupported SQL: ${sql}`);
  }
}

function applyWorkflowColumn(row: WorkflowRow, col: string, v: unknown) {
  switch (col) {
    case "name":               row.name = v as string; break;
    case "description":        row.description = (v ?? null) as string | null; break;
    case "engine":             row.engine = v as string; break;
    case "model":              row.model = (v ?? null) as string | null; break;
    case "max_turns":          row.max_turns = v as number; break;
    case "max_continuations":  row.max_continuations = (v ?? null) as number | null; break;
    case "allowed_tools":      row.allowed_tools = (v ?? null) as string | null; break;
    case "disallowed_tools":   row.disallowed_tools = (v ?? null) as string | null; break;
    case "allowed_domains":    row.allowed_domains = (v ?? null) as string | null; break;
    case "mcp_servers":        row.mcp_servers = (v ?? null) as string | null; break;
    case "permission_mode":    row.permission_mode = (v ?? null) as string | null; break;
    case "additional_read_paths":  row.additional_read_paths = (v ?? null) as string | null; break;
    case "additional_write_paths": row.additional_write_paths = (v ?? null) as string | null; break;
    case "hook_after_create":  row.hook_after_create = (v ?? null) as string | null; break;
    case "hook_before_remove": row.hook_before_remove = (v ?? null) as string | null; break;
    case "hook_timeout_ms":    row.hook_timeout_ms = v as number; break;
    case "prompt_template":    row.prompt_template = v as string; break;
    case "status":             row.status = v as string; break;
    case "published_at":       row.published_at = (v ?? null) as number | null; break;
    case "version":            row.version = v as number; break;
    case "version + 1":        row.version = row.version + 1; break;
    case "updated_at":         row.updated_at = v as number; break;
  }
}

function applyProjectColumn(row: ProjectRow, col: string, v: unknown) {
  switch (col) {
    case "linear_team_id":         row.linear_team_id = v as string; break;
    case "linear_team_name":       row.linear_team_name = v as string; break;
    case "repo_url":               row.repo_url = v as string; break;
    case "default_branch":         row.default_branch = v as string; break;
    case "engine":                 row.engine = v as string; break;
    case "model":                  row.model = (v ?? null) as string | null; break;
    case "max_turns":              row.max_turns = v as number; break;
    case "scope":                  row.scope = (v ?? null) as string | null; break;
    case "system_prompt_override": row.system_prompt_override = (v ?? null) as string | null; break;
    case "updated_at":             row.updated_at = v as number; break;
  }
}

function applyTriggerColumn(row: TriggerRow, col: string, v: unknown) {
  switch (col) {
    case "event_type":         row.event_type = v as string; break;
    case "action":             row.action = v as string; break;
    case "priority":           row.priority = v as number; break;
    case "enabled":            row.enabled = v as number; break;
    case "to_state":           row.to_state = (v ?? null) as string | null; break;
    case "from_state":         row.from_state = (v ?? null) as string | null; break;
    case "label_name":         row.label_name = (v ?? null) as string | null; break;
    case "comment_match":      row.comment_match = (v ?? null) as string | null; break;
    case "team_filter":        row.team_filter = (v ?? null) as string | null; break;
    case "project_filter":     row.project_filter = (v ?? null) as string | null; break;
    case "label_filter":       row.label_filter = (v ?? null) as string | null; break;
    case "skip_label_filter":  row.skip_label_filter = (v ?? null) as string | null; break;
    case "assignee_filter":    row.assignee_filter = (v ?? null) as string | null; break;
    case "action_params":      row.action_params = (v ?? null) as string | null; break;
    case "updated_at":         row.updated_at = v as number; break;
  }
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// ── Env scaffolding ────────────────────────────────────────────────

class FakeKV {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

function makeEnv(db: ApiD1, overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    LINEAR_TOKENS: new FakeKV() as unknown as KVNamespace,
    SESSION_RUNNER: { create: vi.fn() } as unknown as Workflow,
    DB: db as unknown as D1Database,
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
    LINEAR_WEBHOOK_SECRET: "wh-secret",
    DISPATCHER_URL: "https://dispatcher.example",
    DISPATCH_HMAC_SECRET: "hmac-secret",
    URL: "https://agent.example",
    DEFAULT_SCOPE: "default",
    DEFAULT_MODEL: "anthropic/claude-sonnet-4-6",
    DEFAULT_ENGINE: "pi",
    ADMIN_TOKEN: "admin-secret",
    ...overrides,
  };
}

function makeExecCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

function asUser(orgId = "org-1", userId = "user-1") {
  requireDashboardAuthMock.mockResolvedValue({
    userId,
    organizationId: orgId,
    email: "user@example.com",
    name: "User",
    image: null,
  });
}

function asAnonymous() {
  requireDashboardAuthMock.mockResolvedValue(null);
}

beforeEach(() => {
  requireDashboardAuthMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Auth ───────────────────────────────────────────────────────────

describe("/api/v1 auth", () => {
  it("returns 401 with no credentials", async () => {
    asAnonymous();
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unauthorized");
    expect(typeof body.message).toBe("string");
  });

  it("returns 401 when a bearer token has no matching api_tokens row", async () => {
    asAnonymous();
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows", {
        headers: { Authorization: "Bearer not-a-real-token" },
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when a malformed Authorization header arrives", async () => {
    asAnonymous();
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows", {
        headers: { Authorization: "NotABearerScheme abcdef" },
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid session cookie via the mocked dashboard auth", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { workflows: unknown[] };
    expect(json.workflows).toEqual([]);
  });
});

// ── Workflows CRUD ─────────────────────────────────────────────────

describe("/api/v1/workflows", () => {
  it("rejects bodies that fail Zod validation", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // missing required `name` and `prompt_template`.
        body: JSON.stringify({}),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; issues: unknown[] };
    expect(json.error).toBe("validation_failed");
    expect(Array.isArray(json.issues)).toBe(true);
  });

  it("rejects unsupported runtime policy fields instead of storing ignored constraints", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Unsupported policy",
          prompt_template: "Run",
          allowed_domains: ["example.com"],
          mcp_servers: [{ name: "local", command: "server" }],
          additional_read_paths: ["/tmp/read"],
          additional_write_paths: ["/tmp/write"],
          hook_after_create: "echo setup",
          hook_before_remove: "echo cleanup",
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: string;
      issues: Array<{ path: string[] }>;
    };
    expect(json.error).toBe("validation_failed");
    expect(json.issues.map((i) => i.path[0]).sort()).toEqual([
      "additional_read_paths",
      "additional_write_paths",
      "allowed_domains",
      "hook_after_create",
      "hook_before_remove",
      "mcp_servers",
    ]);
  });

  it("accepts dispatcher-supported workflow policy fields", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Supported policy",
          prompt_template: "Run",
          allowed_tools: ["Read", "Bash"],
          disallowed_tools: ["WebFetch"],
          permission_mode: "ask",
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { workflow: Record<string, unknown> };
    expect(json.workflow.allowed_tools).toEqual(["Read", "Bash"]);
    expect(json.workflow.disallowed_tools).toEqual(["WebFetch"]);
    expect(json.workflow.permission_mode).toBe("ask");
  });

  it("creates, reads, updates, and deletes a workflow", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const app = buildApp();

    // CREATE
    const createRes = await app.fetch(
      new Request("https://agent.example/api/v1/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Engineering Default",
          engine: "pi",
          max_turns: 12,
          prompt_template: "Hello {{issue.title}}",
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      workflow: { id: string; name: string; max_turns: number };
    };
    expect(created.workflow.name).toBe("Engineering Default");
    expect(created.workflow.max_turns).toBe(12);
    const id = created.workflow.id;

    // READ
    const getRes = await app.fetch(
      new Request(`https://agent.example/api/v1/workflows/${id}`),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(getRes.status).toBe(200);

    // LIST
    const listRes = await app.fetch(
      new Request("https://agent.example/api/v1/workflows"),
      makeEnv(db),
      makeExecCtx(),
    );
    const list = (await listRes.json()) as { workflows: Array<{ id: string }> };
    expect(list.workflows).toHaveLength(1);

    // UPDATE
    const putRes = await app.fetch(
      new Request(`https://agent.example/api/v1/workflows/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_turns: 25 }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(putRes.status).toBe(200);
    const updated = (await putRes.json()) as {
      workflow: { max_turns: number };
    };
    expect(updated.workflow.max_turns).toBe(25);

    // DELETE
    const delRes = await app.fetch(
      new Request(`https://agent.example/api/v1/workflows/${id}`, {
        method: "DELETE",
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(delRes.status).toBe(200);
    expect(db.workflows.has(id)).toBe(false);
  });

  it("publish flips status and writes a workflow_versions snapshot row", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const app = buildApp();

    const createRes = await app.fetch(
      new Request("https://agent.example/api/v1/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Pub",
          prompt_template: "x",
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    const { workflow } = (await createRes.json()) as {
      workflow: { id: string };
    };

    const pubRes = await app.fetch(
      new Request(
        `https://agent.example/api/v1/workflows/${workflow.id}/publish`,
        { method: "POST" },
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(pubRes.status).toBe(200);
    const body = (await pubRes.json()) as {
      workflow: { status: string; published_at: number | null };
      version: { version: number };
    };
    expect(body.workflow.status).toBe("published");
    expect(body.workflow.published_at).toBeGreaterThan(0);
    expect(body.version.version).toBe(1);
    expect(db.versions).toHaveLength(1);
    expect(db.versions[0]?.workflow_id).toBe(workflow.id);
  });

  it("PUT does not overwrite unset fields with schema defaults", async () => {
    // Regression test: WorkflowUpdateSchema must not apply `.default(...)`
    // values from WorkflowCreateSchema. A bare {description: "x"} PUT
    // should leave engine / max_turns / hook_timeout_ms untouched.
    asUser("org-1");
    const db = new ApiD1();
    db.workflows.set(
      "w1",
      baseWorkflow({
        id: "w1",
        organization_id: "org-1",
        engine: "claude",
        max_turns: 5,
        hook_timeout_ms: 600000,
      }),
    );

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows/w1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "new" }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflow: { engine: string; max_turns: number; hook_timeout_ms: number; description: string };
    };
    expect(body.workflow.engine).toBe("claude");
    expect(body.workflow.max_turns).toBe(5);
    expect(body.workflow.hook_timeout_ms).toBe(600000);
    expect(body.workflow.description).toBe("new");
  });

  it("PUT updates a published workflow in place (no status gate)", async () => {
    asUser("org-1");
    const db = new ApiD1();
    db.workflows.set(
      "w1",
      baseWorkflow({ id: "w1", organization_id: "org-1", status: "published" }),
    );

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows/w1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_turns: 99 }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflow: { max_turns: number; status: string };
    };
    expect(body.workflow.max_turns).toBe(99);
    // Status is unchanged — PUT is content-only; explicit POST /publish
    // still controls versioned snapshots.
    expect(body.workflow.status).toBe("published");
  });

  it("test-run route is gone (404)", async () => {
    asUser("org-1");
    const db = new ApiD1();
    db.workflows.set("w1", baseWorkflow({ id: "w1", organization_id: "org-1" }));

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows/w1/test-run", {
        method: "POST",
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(404);
  });

  it("list returns next_cursor when the page is full", async () => {
    asUser("org-1");
    const db = new ApiD1();
    for (let i = 0; i < 3; i++) {
      db.workflows.set(`w${i}`, baseWorkflow({
        id: `w${i}`,
        organization_id: "org-1",
        created_at: i * 10,
      }));
    }
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows?limit=2"),
      makeEnv(db),
      makeExecCtx(),
    );
    const body = (await res.json()) as {
      workflows: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(body.workflows).toHaveLength(2);
    expect(body.next_cursor).toBe(body.workflows[1]!.id);
  });

  it("filters list by status", async () => {
    asUser("org-1");
    const db = new ApiD1();
    db.workflows.set("draft1", baseWorkflow({
      id: "draft1", organization_id: "org-1", status: "draft", created_at: 1,
    }));
    db.workflows.set("pub1", baseWorkflow({
      id: "pub1", organization_id: "org-1", status: "published", created_at: 2,
    }));
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows?status=published"),
      makeEnv(db),
      makeExecCtx(),
    );
    const body = (await res.json()) as { workflows: Array<{ id: string; status: string }> };
    expect(body.workflows).toHaveLength(1);
    expect(body.workflows[0]?.id).toBe("pub1");
  });

  it("replays the POST response when Idempotency-Key matches", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const env = makeEnv(db);
    const body = JSON.stringify({ name: "idem", prompt_template: "x" });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "client-uuid-1",
    };
    const app = buildApp();

    const first = await app.fetch(
      new Request("https://agent.example/api/v1/workflows", {
        method: "POST",
        headers,
        body,
      }),
      env,
      makeExecCtx(),
    );
    const second = await app.fetch(
      new Request("https://agent.example/api/v1/workflows", {
        method: "POST",
        headers,
        body,
      }),
      env,
      makeExecCtx(),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(db.workflows.size).toBe(1);
  });

  it("duplicate idempotency is scoped to the source workflow id", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const env = makeEnv(db);
    db.workflows.set("w1", baseWorkflow({ id: "w1", organization_id: "org-1", name: "Alpha" }));
    db.workflows.set("w2", baseWorkflow({ id: "w2", organization_id: "org-1", name: "Beta" }));
    const app = buildApp();
    const headers = { "Idempotency-Key": "dup-key-1" };

    // Duplicate w1
    const first = await app.fetch(
      new Request("https://agent.example/api/v1/workflows/w1/duplicate", {
        method: "POST",
        headers,
      }),
      env,
      makeExecCtx(),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { workflow: { id: string; name: string } };
    expect(firstBody.workflow.name).toBe("Alpha (copy)");

    // Duplicate w2 with the same key — must create independently, not replay w1's duplicate
    const second = await app.fetch(
      new Request("https://agent.example/api/v1/workflows/w2/duplicate", {
        method: "POST",
        headers,
      }),
      env,
      makeExecCtx(),
    );
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotent-Replayed")).toBeNull();
    const secondBody = (await second.json()) as { workflow: { id: string; name: string } };
    expect(secondBody.workflow.name).toBe("Beta (copy)");
    expect(secondBody.workflow.id).not.toBe(firstBody.workflow.id);

    // Re-duplicate w1 with the same key — must replay the first duplicate
    const third = await app.fetch(
      new Request("https://agent.example/api/v1/workflows/w1/duplicate", {
        method: "POST",
        headers,
      }),
      env,
      makeExecCtx(),
    );
    expect(third.status).toBe(201);
    expect(third.headers.get("Idempotent-Replayed")).toBe("true");
    const thirdBody = (await third.json()) as { workflow: { id: string; name: string } };
    expect(thirdBody.workflow.id).toBe(firstBody.workflow.id);
  });

  it("rejects cross-org workflow access (orgId scoping)", async () => {
    asUser("org-2");
    const db = new ApiD1();
    db.workflows.set("w1", baseWorkflow({ id: "w1", organization_id: "org-1" }));

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows/w1"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(404);
  });
});

// ── Triggers ───────────────────────────────────────────────────────

describe("/api/v1/workflows/:id/triggers", () => {
  it("creates a trigger and lists it back", async () => {
    asUser("org-1");
    const db = new ApiD1();
    db.workflows.set("w1", baseWorkflow({ id: "w1", organization_id: "org-1" }));

    const app = buildApp();
    const createRes = await app.fetch(
      new Request("https://agent.example/api/v1/workflows/w1/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "state_entered",
          to_state: "Todo",
          action: "start_session",
          priority: 5,
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      trigger: { id: string; to_state: string };
    };
    expect(created.trigger.to_state).toBe("Todo");

    const listRes = await app.fetch(
      new Request("https://agent.example/api/v1/workflows/w1/triggers"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      triggers: Array<{ id: string }>;
    };
    expect(list.triggers).toHaveLength(1);
  });

  it("rejects an invalid event_type via Zod", async () => {
    asUser("org-1");
    const db = new ApiD1();
    db.workflows.set("w1", baseWorkflow({ id: "w1", organization_id: "org-1" }));

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows/w1/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "not_a_real_event",
          action: "start_session",
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
  });
});

// ── API tokens ─────────────────────────────────────────────────────

describe("/api/v1/api-tokens", () => {
  it("creates a token, returns plaintext once, persists only the hash", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ci-pipeline",
          scopes: ["read", "write"],
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: {
        id: string;
        name: string;
        scopes: string[];
        plaintext: string;
        last_used_at: number | null;
      };
    };
    expect(body.token.name).toBe("ci-pipeline");
    expect(body.token.scopes).toEqual(["read", "write"]);
    expect(body.token.plaintext.startsWith("tok_")).toBe(true);
    expect(body.token.last_used_at).toBeNull();
    // Only the hash should be stored — never the plaintext.
    expect(db.apiTokens).toHaveLength(1);
    expect(db.apiTokens[0]?.token_hash).not.toBe(body.token.plaintext);
    expect(db.apiTokens[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects unknown scopes", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad",
          scopes: ["read", "superuser"],
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  it("lists tokens without plaintext or hash", async () => {
    asUser("org-1");
    const db = new ApiD1();
    db.apiTokens.push({
      id: "t1",
      organization_id: "org-1",
      name: "ci",
      token_hash: "deadbeef",
      scopes: JSON.stringify(["read"]),
      created_at: 100,
      last_used_at: null,
    });
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/api-tokens"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokens: Array<Record<string, unknown>>;
    };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toEqual({
      id: "t1",
      name: "ci",
      scopes: ["read"],
      created_at: 100,
      last_used_at: null,
    });
    expect(body.tokens[0]).not.toHaveProperty("token_hash");
    expect(body.tokens[0]).not.toHaveProperty("plaintext");
  });

  it("revokes a token", async () => {
    asUser("org-1");
    const db = new ApiD1();
    db.apiTokens.push({
      id: "t1",
      organization_id: "org-1",
      name: "ci",
      token_hash: "h",
      scopes: null,
      created_at: 0,
      last_used_at: null,
    });
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/api-tokens/t1", {
        method: "DELETE",
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(db.apiTokens).toHaveLength(0);
  });

  it("cross-org delete returns 404", async () => {
    asUser("org-2");
    const db = new ApiD1();
    db.apiTokens.push({
      id: "t1",
      organization_id: "org-1",
      name: "ci",
      token_hash: "h",
      scopes: null,
      created_at: 0,
      last_used_at: null,
    });
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/api-tokens/t1", {
        method: "DELETE",
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(404);
    expect(db.apiTokens).toHaveLength(1);
  });
});

// ── Scope enforcement (bearer path) ────────────────────────────────

describe("scope enforcement", () => {
  // Plant a bearer token row in the DB and call /api/v1/* with it. The
  // cookie path is mocked anonymous so the bearer is the only credential.
  async function seedToken(
    db: ApiD1,
    plaintext: string,
    scopes: string[],
    orgId = "org-1",
  ): Promise<void> {
    const { hashToken } = await import("../src/lib/auth/bearer");
    const hash = await hashToken(plaintext);
    db.apiTokens.push({
      id: `tok-${plaintext}`,
      organization_id: orgId,
      name: "test",
      token_hash: hash,
      scopes: JSON.stringify(scopes),
      created_at: 0,
      last_used_at: null,
    });
  }

  it("read-scoped token can GET but not POST workflows", async () => {
    asAnonymous();
    const db = new ApiD1();
    await seedToken(db, "tok-read", ["read"]);

    const getRes = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows", {
        headers: { Authorization: "Bearer tok-read" },
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(getRes.status).toBe(200);

    const postRes = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-read",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "x", prompt_template: "y" }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(postRes.status).toBe(403);
    const body = (await postRes.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  it("write-scoped token cannot mint a new api-token (admin required)", async () => {
    asAnonymous();
    const db = new ApiD1();
    await seedToken(db, "tok-write", ["write"]);

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/api-tokens", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-write",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "child", scopes: ["read"] }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("admin-scoped token can mint a new api-token", async () => {
    asAnonymous();
    const db = new ApiD1();
    await seedToken(db, "tok-admin", ["admin"]);

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/api-tokens", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "child", scopes: ["read"] }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(201);
  });

  it("touches last_used_at on a successful bearer call", async () => {
    asAnonymous();
    const db = new ApiD1();
    await seedToken(db, "tok-touch", ["read"]);
    const before = db.apiTokens[0]?.last_used_at;
    expect(before).toBeNull();

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows", {
        headers: { Authorization: "Bearer tok-touch" },
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    // The UPDATE fires fire-and-forget (no waitUntil in the test ctx),
    // so flush the microtask queue before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(db.apiTokens[0]?.last_used_at).not.toBeNull();
  });
});

// ── Projects ───────────────────────────────────────────────────────

describe("/api/v1/projects", () => {
  it("creates, reads, updates, lists, and deletes a project", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const app = buildApp();

    const createRes = await app.fetch(
      new Request("https://agent.example/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          linear_team_id: "team-A",
          repo_url: "https://github.com/example/repo",
          default_branch: "main",
          engine: "pi",
          max_turns: 15,
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      project: { id: string; linear_team_id: string; max_turns: number };
    };
    expect(created.project.linear_team_id).toBe("team-A");
    expect(created.project.max_turns).toBe(15);
    const id = created.project.id;

    // LIST
    const listRes = await app.fetch(
      new Request("https://agent.example/api/v1/projects"),
      makeEnv(db),
      makeExecCtx(),
    );
    const list = (await listRes.json()) as { projects: Array<{ id: string }> };
    expect(list.projects).toHaveLength(1);

    // GET by id
    const getRes = await app.fetch(
      new Request(`https://agent.example/api/v1/projects/${id}`),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(getRes.status).toBe(200);

    // UPDATE
    const putRes = await app.fetch(
      new Request(`https://agent.example/api/v1/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_turns: 25 }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(putRes.status).toBe(200);
    const updated = (await putRes.json()) as {
      project: { max_turns: number };
    };
    expect(updated.project.max_turns).toBe(25);

    // DELETE
    const delRes = await app.fetch(
      new Request(`https://agent.example/api/v1/projects/${id}`, {
        method: "DELETE",
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(delRes.status).toBe(200);
    expect(db.projects.size).toBe(0);
  });

  it("returns 409 conflict when creating a duplicate (org, linear_team_id)", async () => {
    asUser("org-1");
    const db = new ApiD1();
    db.projects.set("p1", {
      id: "p1",
      organization_id: "org-1",
      linear_team_id: "team-A",
      linear_team_name: "",
      repo_url: "https://x",
      default_branch: "main",
      engine: "pi",
      model: null,
      max_turns: 10,
      scope: null,
      system_prompt_override: null,
      created_at: 0,
      updated_at: 0,
    });

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          linear_team_id: "team-A",
          repo_url: "https://github.com/x/y",
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("conflict");
  });

  it("rejects invalid repo_url", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          linear_team_id: "team-A",
          repo_url: "not-a-url",
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("enforces org scoping on GET/PUT/DELETE", async () => {
    asUser("org-2");
    const db = new ApiD1();
    db.projects.set("p1", {
      id: "p1",
      organization_id: "org-1",
      linear_team_id: "team-A",
      linear_team_name: "",
      repo_url: "https://x",
      default_branch: "main",
      engine: "pi",
      model: null,
      max_turns: 10,
      scope: null,
      system_prompt_override: null,
      created_at: 0,
      updated_at: 0,
    });
    const app = buildApp();

    const getRes = await app.fetch(
      new Request("https://agent.example/api/v1/projects/p1"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(getRes.status).toBe(404);

    const delRes = await app.fetch(
      new Request("https://agent.example/api/v1/projects/p1", {
        method: "DELETE",
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(delRes.status).toBe(404);
  });
});

// ── Webhook events ─────────────────────────────────────────────────

describe("/api/v1/webhook-events", () => {
  function seedEvent(
    db: ApiD1,
    id: string,
    receivedAt: number,
    orgId = "org-1",
    extra: Partial<{ signature_ok: number; deduped: number; envelope_type: string }> = {},
  ) {
    db.webhookEvents.push({
      id,
      received_at: receivedAt,
      organization_id: orgId,
      webhook_id: null,
      envelope_type: extra.envelope_type ?? "Issue",
      envelope_action: null,
      signature_ok: extra.signature_ok ?? 1,
      deduped: extra.deduped ?? 0,
      matched_workflow_id: null,
      matched_trigger_id: null,
      dispatched_action: "start_session",
      agent_session_id: null,
      error: null,
      latency_ms: 0,
      event_summary: null,
      raw_body: null,
    });
  }

  it("lists events with cursor pagination", async () => {
    asUser("org-1");
    const db = new ApiD1();
    seedEvent(db, "e1", 100);
    seedEvent(db, "e2", 200);
    seedEvent(db, "e3", 300);

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/webhook-events?limit=2"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      webhook_events: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(body.webhook_events.map((e) => e.id)).toEqual(["e3", "e2"]);
    expect(body.next_cursor).toBe("e2");

    // Follow the cursor.
    const next = await buildApp().fetch(
      new Request(`https://agent.example/api/v1/webhook-events?limit=2&before_id=${body.next_cursor}`),
      makeEnv(db),
      makeExecCtx(),
    );
    const nextBody = (await next.json()) as { webhook_events: Array<{ id: string }>; next_cursor: string | null };
    expect(nextBody.webhook_events.map((e) => e.id)).toEqual(["e1"]);
    expect(nextBody.next_cursor).toBeNull();
  });

  it("filters by signature_ok", async () => {
    asUser("org-1");
    const db = new ApiD1();
    seedEvent(db, "ok", 1, "org-1", { signature_ok: 1 });
    seedEvent(db, "bad", 2, "org-1", { signature_ok: 0 });
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/webhook-events?signature_ok=false"),
      makeEnv(db),
      makeExecCtx(),
    );
    const body = (await res.json()) as { webhook_events: Array<{ id: string }> };
    expect(body.webhook_events.map((e) => e.id)).toEqual(["bad"]);
  });

  it("filters by since_ts", async () => {
    asUser("org-1");
    const db = new ApiD1();
    seedEvent(db, "old", 50);
    seedEvent(db, "new", 500);
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/webhook-events?since_ts=100"),
      makeEnv(db),
      makeExecCtx(),
    );
    const body = (await res.json()) as { webhook_events: Array<{ id: string }> };
    expect(body.webhook_events.map((e) => e.id)).toEqual(["new"]);
  });

  it("legacy /webhooks alias emits Sunset + Deprecation headers", async () => {
    asUser("org-1");
    const db = new ApiD1();
    seedEvent(db, "e1", 1);
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/webhooks"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Sunset")).toBeTruthy();
    expect(res.headers.get("Deprecation")).toBe("true");
    const body = (await res.json()) as { webhooks: unknown[] };
    expect(body.webhooks).toHaveLength(1);
  });
});

// ── Settings ───────────────────────────────────────────────────────

describe("/api/v1/settings", () => {
  it("lists settings + agent_defaults", async () => {
    asUser("org-1");
    const db = new ApiD1();
    db.settings.set("org-1:foo", {
      organization_id: "org-1",
      key: "foo",
      value: "bar",
    });
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/settings"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: Array<{ key: string; value: string }>;
      agent_defaults: { default_engine: string; max_turns: number };
    };
    expect(body.settings).toContainEqual({ key: "foo", value: "bar" });
    expect(body.agent_defaults.default_engine).toBe("pi");
    expect(body.agent_defaults.max_turns).toBe(10);
  });

  it("upserts an arbitrary key", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/settings/proxy.host", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "proxy.example" }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(db.settings.get("org-1:proxy.host")?.value).toBe("proxy.example");
  });

  it("rejects curated keys with invalid values", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/settings/agent.max_turns", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "9999" }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("validation_failed");
    expect(body.message).toMatch(/capped at 100/);
  });

  it("returns 404 when getting a missing key", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/settings/missing"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(404);
  });
});

// ── Integrations ───────────────────────────────────────────────────

describe("/api/v1/integrations", () => {
  it("returns connected: false for every provider when nothing is installed", async () => {
    asUser("org-1");
    const db = new ApiD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/integrations"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      linear: { connected: boolean };
      github: { connected: boolean };
      anthropic: { configured: boolean };
    };
    expect(body.linear.connected).toBe(false);
    expect(body.github.connected).toBe(false);
    expect(body.anthropic.configured).toBe(false);
  });
});

function baseWorkflow(overrides: Partial<WorkflowRow> & { id: string }): WorkflowRow {
  return {
    organization_id: overrides.organization_id ?? "org-1",
    team_id: null,
    user_id: null,
    name: "test",
    description: null,
    engine: "pi",
    model: null,
    max_turns: 10,
    max_continuations: null,
    allowed_tools: null,
    disallowed_tools: null,
    allowed_domains: null,
    mcp_servers: null,
    permission_mode: null,
    additional_read_paths: null,
    additional_write_paths: null,
    hook_after_create: null,
    hook_before_remove: null,
    hook_timeout_ms: 300000,
    prompt_template: "x",
    version: 1,
    status: "draft",
    published_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}
