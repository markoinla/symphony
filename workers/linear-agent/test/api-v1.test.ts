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

class ApiD1 {
  workflows = new Map<string, WorkflowRow>();
  triggers = new Map<string, TriggerRow>();
  versions: VersionRow[] = [];
  apiTokens: Array<{
    id: string;
    organization_id: string;
    token_hash: string;
    scopes: string | null;
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
      return {
        id: row.id,
        organization_id: row.organization_id,
        name: "",
        token_hash: row.token_hash,
        scopes: row.scopes,
        created_at: 0,
        last_used_at: null,
      } as unknown as T;
    }

    throw new Error(`ApiD1.first: unsupported SQL: ${sql}`);
  }

  async all<T>(): Promise<{ success: true; results: T[] }> {
    const sql = norm(this.sql);

    if (/FROM workflows WHERE organization_id = \? ORDER BY created_at/i.test(sql)) {
      const [orgId] = this.bindings as [string];
      const rows = Array.from(this.db.workflows.values())
        .filter((w) => w.organization_id === orgId)
        .sort((a, b) => b.created_at - a.created_at);
      return { success: true, results: rows as unknown as T[] };
    }

    if (/FROM workflow_triggers WHERE workflow_id/i.test(sql)) {
      const [workflowId] = this.bindings as [string];
      const rows = Array.from(this.db.triggers.values())
        .filter((t) => t.workflow_id === workflowId)
        .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
      return { success: true, results: rows as unknown as T[] };
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
    expect(await res.json()).toEqual({ error: "unauthorized" });
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
    expect(json.error).toBe("invalid_body");
    expect(Array.isArray(json.issues)).toBe(true);
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

  it("test-run returns 501 + not yet implemented", async () => {
    asUser("org-1");
    const db = new ApiD1();
    // Seed a workflow to make sure the 501 isn't masking a 404.
    db.workflows.set("w1", baseWorkflow({ id: "w1", organization_id: "org-1" }));

    const res = await buildApp().fetch(
      new Request("https://agent.example/api/v1/workflows/w1/test-run", {
        method: "POST",
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "not yet implemented" });
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
