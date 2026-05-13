// MCP transport tests. The MCP router dispatches into the v1 REST
// surface via a synthetic Request, so we re-use the same ApiD1 mock
// shape from api-v1.test.ts. The tests assert:
//   1. Bearer-only — cookie/anonymous calls 401.
//   2. tools/list reflects token scopes.
//   3. tools/call round-trips into v1 (creates a workflow, reads it back).
//   4. Unknown methods / tools produce JSON-RPC error envelopes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireDashboardAuthMock } = vi.hoisted(() => ({
  requireDashboardAuthMock: vi.fn(),
}));

vi.mock("../src/lib/dashboard-auth", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/lib/dashboard-auth")
  >();
  return { ...actual, requireDashboardAuth: requireDashboardAuthMock };
});

import { buildApp, type Env } from "../src/index";

// Minimal D1 shim. The MCP path that exercises actual v1 logic in this
// test only touches `api_tokens` (scope lookup) + `workflows` (the
// tools/call round-trip). Other tables are mocked to return empty.
class McpD1 {
  workflows = new Map<string, Record<string, unknown>>();
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
    return new McpStmt(this, sql);
  }
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

class McpStmt {
  private bindings: unknown[] = [];
  private sql: string;
  constructor(private db: McpD1, rawSql: string) {
    this.sql = norm(rawSql);
  }
  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }
  async run() {
    if (/^INSERT INTO workflows/i.test(this.sql)) {
      // Capture id and minimal fields needed to read back. Full
      // round-trip fidelity isn't required for the MCP test — we just
      // need the row to exist for the subsequent GET.
      const b = this.bindings;
      const id = b[0] as string;
      const organization_id = b[1] as string;
      const name = b[2] as string;
      this.db.workflows.set(id, {
        id,
        organization_id,
        team_id: null,
        user_id: null,
        name,
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
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^UPDATE api_tokens SET last_used_at/i.test(this.sql)) {
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
  async first<T>(): Promise<T | null> {
    if (/FROM api_tokens WHERE token_hash/i.test(this.sql)) {
      const [hash] = this.bindings as [string];
      const row = this.db.apiTokens.find((t) => t.token_hash === hash);
      return (row as unknown as T) ?? null;
    }
    if (/FROM workflows WHERE id = \? AND organization_id/i.test(this.sql)) {
      const [id, orgId] = this.bindings as [string, string];
      const row = this.db.workflows.get(id);
      if (!row || row.organization_id !== orgId) return null;
      return row as unknown as T;
    }
    return null;
  }
  async all<T>(): Promise<{ success: true; results: T[] }> {
    if (/FROM workflows\s+WHERE/i.test(this.sql)) {
      const orgId = this.bindings[0] as string;
      const rows = Array.from(this.db.workflows.values()).filter(
        (w) => w.organization_id === orgId,
      );
      return { success: true, results: rows as unknown as T[] };
    }
    return { success: true, results: [] as unknown as T[] };
  }
}

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

function makeEnv(db: McpD1): Env {
  return {
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    LINEAR_TOKENS: new FakeKV() as unknown as KVNamespace,
    SESSION_RUNNER: {} as unknown as Workflow,
    DB: db as unknown as D1Database,
    LINEAR_CLIENT_ID: "x",
    LINEAR_CLIENT_SECRET: "x",
    LINEAR_WEBHOOK_SECRET: "x",
    DISPATCHER_URL: "https://dispatcher.example",
    DISPATCH_HMAC_SECRET: "x",
    URL: "https://agent.example",
    DEFAULT_SCOPE: "x",
    DEFAULT_MODEL: "x",
    DEFAULT_ENGINE: "pi",
  };
}

function makeExecCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

async function seedToken(
  db: McpD1,
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

beforeEach(() => {
  // MCP path explicitly rejects cookie sessions, but the lookupScopes
  // helper makes a real DB call. Default to "no cookie".
  requireDashboardAuthMock.mockReset();
  requireDashboardAuthMock.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("POST /mcp", () => {
  it("rejects requests without a bearer token", async () => {
    const db = new McpD1();
    const res = await buildApp().fetch(
      new Request("https://agent.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("responds to initialize", async () => {
    const db = new McpD1();
    await seedToken(db, "tok1", ["read"]);
    const res = await buildApp().fetch(
      new Request("https://agent.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { protocolVersion: string; capabilities: { tools: unknown } };
    };
    expect(body.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("tools/list returns only read-scope tools for a read-only token", async () => {
    const db = new McpD1();
    await seedToken(db, "tok-read", ["read"]);
    const res = await buildApp().fetch(
      new Request("https://agent.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-read",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("workflows.list");
    expect(names).not.toContain("workflows.create");
    expect(names).not.toContain("projects.delete");
  });

  it("tools/list expands to write-scope tools for a read+write token", async () => {
    const db = new McpD1();
    await seedToken(db, "tok-rw", ["read", "write"]);
    const res = await buildApp().fetch(
      new Request("https://agent.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-rw",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("workflows.create");
    expect(names).toContain("workflows.update");
    expect(names).not.toContain("api_tokens.create"); // token CRUD never exposed
  });

  it("tools/call round-trips into the v1 REST surface", async () => {
    const db = new McpD1();
    await seedToken(db, "tok-rw", ["read", "write"]);

    const callRes = await buildApp().fetch(
      new Request("https://agent.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-rw",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "workflows.create",
            arguments: { name: "From MCP", prompt_template: "Hello {{x}}" },
          },
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(callRes.status).toBe(200);
    const body = (await callRes.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
        structuredContent: { workflow: { id: string; name: string }; error?: string; message?: string };
        _meta: { http_status: number };
      };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result._meta.http_status).toBe(201);
    expect(body.result.structuredContent.workflow.name).toBe("From MCP");
    // Round-trip: row landed in the DB through the v1 INSERT path.
    expect(db.workflows.size).toBe(1);
  });

  it("tools/call surfaces v1 errors as isError + structuredContent", async () => {
    const db = new McpD1();
    await seedToken(db, "tok-r", ["read"]);
    const res = await buildApp().fetch(
      new Request("https://agent.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-r",
          "Content-Type": "application/json",
        },
        // Read token cannot create — v1 returns 403 forbidden.
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "workflows.create",
            arguments: { name: "denied", prompt_template: "x" },
          },
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        structuredContent: { error: string };
        _meta: { http_status: number };
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result._meta.http_status).toBe(403);
    expect(body.result.structuredContent.error).toBe("forbidden");
  });

  it("returns MethodNotFound for an unknown tool", async () => {
    const db = new McpD1();
    await seedToken(db, "tok-rw", ["read", "write"]);
    const res = await buildApp().fetch(
      new Request("https://agent.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-rw",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "imaginary.tool", arguments: {} },
        }),
      }),
      makeEnv(db),
      makeExecCtx(),
    );
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toMatch(/No such tool/);
  });
});
