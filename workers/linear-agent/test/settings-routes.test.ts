// /dashboard/api/settings — CRUD + per-key validation tests.
//
// `requireOrg` is mocked at module scope so we don't need a live
// Better Auth + cookie jar; positive cases run as `org-1`. The fake
// D1 below only models the `settings` table's SQL surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireOrgMock } = vi.hoisted(() => {
  return { requireOrgMock: vi.fn() };
});

vi.mock("../src/lib/dashboard-auth", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/lib/dashboard-auth")
  >();
  return {
    ...actual,
    requireOrg: requireOrgMock,
  };
});

import { buildApp, type Env } from "../src/index";

// ── Minimal D1 fake for the settings table ─────────────────────────

interface SettingRow {
  id: string;
  organization_id: string;
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

class SettingsD1 {
  rows = new Map<string, SettingRow>(); // keyed by `${org}:${key}`

  prepare(sql: string) {
    return new SettingsStatement(this, sql);
  }
}

class SettingsStatement {
  private bindings: unknown[] = [];
  constructor(private db: SettingsD1, private sql: string) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async run() {
    const sql = norm(this.sql);

    if (/^INSERT INTO settings/i.test(sql)) {
      const [id, organization_id, key, value, created_at, updated_at] =
        this.bindings as [string, string, string, string, number, number];
      const k = `${organization_id}:${key}`;
      const existing = this.db.rows.get(k);
      if (existing) {
        // ON CONFLICT DO UPDATE — value + updated_at change, rest sticks.
        existing.value = value;
        existing.updated_at = updated_at;
      } else {
        this.db.rows.set(k, {
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
      const [organization_id, key] = this.bindings as [string, string];
      const k = `${organization_id}:${key}`;
      const had = this.db.rows.delete(k);
      return { success: true, meta: { changes: had ? 1 : 0 } };
    }

    throw new Error(`unhandled run sql: ${sql}`);
  }

  async first<T = unknown>(): Promise<T | null> {
    const sql = norm(this.sql);
    if (/^SELECT value FROM settings/i.test(sql)) {
      const [organization_id, key] = this.bindings as [string, string];
      const row = this.db.rows.get(`${organization_id}:${key}`);
      return (row ? { value: row.value } : null) as T | null;
    }
    throw new Error(`unhandled first sql: ${sql}`);
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const sql = norm(this.sql);
    if (/^SELECT key, value FROM settings WHERE organization_id = \?/i.test(sql)) {
      const [organization_id] = this.bindings as [string];
      const rows = [...this.db.rows.values()]
        .filter((r) => r.organization_id === organization_id)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((r) => ({ key: r.key, value: r.value }));
      return { results: rows as T[] };
    }
    throw new Error(`unhandled all sql: ${sql}`);
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

function makeEnv(db: SettingsD1, overrides: Partial<Env> = {}): Env {
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
    DEFAULT_MAX_TURNS: "15",
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

function asUser(orgId = "org-1") {
  requireOrgMock.mockResolvedValue({
    userId: "user-1",
    organizationId: orgId,
    email: "user@example.com",
    name: "User",
    image: null,
  });
}

function asAnonymous() {
  requireOrgMock.mockResolvedValue(null);
}

beforeEach(() => {
  requireOrgMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Auth ───────────────────────────────────────────────────────────

describe("/dashboard/api/settings auth", () => {
  it("returns 401 for unauthenticated GET", async () => {
    asAnonymous();
    const res = await buildApp().fetch(
      new Request("https://agent.example/dashboard/api/settings"),
      makeEnv(new SettingsD1()),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for unauthenticated PUT", async () => {
    asAnonymous();
    const res = await buildApp().fetch(
      new Request("https://agent.example/dashboard/api/settings/agent.default_model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x/y" }),
      }),
      makeEnv(new SettingsD1()),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });
});

// ── GET ────────────────────────────────────────────────────────────

describe("GET /dashboard/api/settings", () => {
  it("returns empty list + agent_defaults derived from env", async () => {
    asUser();
    const res = await buildApp().fetch(
      new Request("https://agent.example/dashboard/api/settings"),
      makeEnv(new SettingsD1()),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: [],
      agent_defaults: {
        default_engine: "pi",
        default_model: "anthropic/claude-sonnet-4-6",
        max_turns: 15,
      },
    });
  });

  it("returns persisted settings scoped by org", async () => {
    asUser("org-1");
    const db = new SettingsD1();
    db.rows.set("org-1:agent.default_model", {
      id: "s1",
      organization_id: "org-1",
      key: "agent.default_model",
      value: "anthropic/claude-haiku-4-5",
      created_at: 1,
      updated_at: 1,
    });
    db.rows.set("org-2:agent.default_model", {
      id: "s2",
      organization_id: "org-2",
      key: "agent.default_model",
      value: "leaky/value",
      created_at: 1,
      updated_at: 1,
    });
    const res = await buildApp().fetch(
      new Request("https://agent.example/dashboard/api/settings"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { key: string; value: string }[];
    };
    expect(body.settings).toEqual([
      { key: "agent.default_model", value: "anthropic/claude-haiku-4-5" },
    ]);
  });

  it("clamps env-derived max_turns above 100", async () => {
    asUser();
    const res = await buildApp().fetch(
      new Request("https://agent.example/dashboard/api/settings"),
      makeEnv(new SettingsD1(), { DEFAULT_MAX_TURNS: "999" }),
      makeExecCtx(),
    );
    const body = (await res.json()) as {
      agent_defaults: { max_turns: number };
    };
    expect(body.agent_defaults.max_turns).toBe(100);
  });
});

// ── PUT ────────────────────────────────────────────────────────────

describe("PUT /dashboard/api/settings/:key", () => {
  it("accepts agent.default_model and persists it", async () => {
    asUser();
    const db = new SettingsD1();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.default_model",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "cf-workers-ai/@cf/test" }),
        },
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setting: { key: "agent.default_model", value: "cf-workers-ai/@cf/test" },
    });
    expect(db.rows.get("org-1:agent.default_model")?.value).toBe(
      "cf-workers-ai/@cf/test",
    );
  });

  it("rejects empty model with 400", async () => {
    asUser();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.default_model",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "   " }),
        },
      ),
      makeEnv(new SettingsD1()),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("validation_failed");
    expect(body.message).toMatch(/non-empty/i);
  });

  it("rejects non-pi engine with 400", async () => {
    asUser();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.default_engine",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "codex" }),
        },
      ),
      makeEnv(new SettingsD1()),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/only `pi`/i);
  });

  it("accepts pi engine", async () => {
    asUser();
    const db = new SettingsD1();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.default_engine",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "pi" }),
        },
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(db.rows.get("org-1:agent.default_engine")?.value).toBe("pi");
  });

  it("rejects non-integer max_turns with 400", async () => {
    asUser();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.max_turns",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "3.5" }),
        },
      ),
      makeEnv(new SettingsD1()),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects max_turns > 100 with 400", async () => {
    asUser();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.max_turns",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "9000" }),
        },
      ),
      makeEnv(new SettingsD1()),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("accepts max_turns within range", async () => {
    asUser();
    const db = new SettingsD1();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.max_turns",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "20" }),
        },
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(db.rows.get("org-1:agent.max_turns")?.value).toBe("20");
  });

  it("upserts (a second PUT replaces value)", async () => {
    asUser();
    const db = new SettingsD1();
    db.rows.set("org-1:agent.default_model", {
      id: "s1",
      organization_id: "org-1",
      key: "agent.default_model",
      value: "old/value",
      created_at: 1,
      updated_at: 1,
    });
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.default_model",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "new/value" }),
        },
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(db.rows.get("org-1:agent.default_model")?.value).toBe("new/value");
  });

  it("accepts non-curated keys without validation", async () => {
    asUser();
    const db = new SettingsD1();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/tracker.api_key",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "lin_api_anything" }),
        },
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
  });

  it("rejects missing value with 400", async () => {
    asUser();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.default_model",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
      makeEnv(new SettingsD1()),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
  });
});

// ── DELETE ─────────────────────────────────────────────────────────

describe("DELETE /dashboard/api/settings/:key", () => {
  it("removes the setting row", async () => {
    asUser();
    const db = new SettingsD1();
    db.rows.set("org-1:agent.default_model", {
      id: "s1",
      organization_id: "org-1",
      key: "agent.default_model",
      value: "x/y",
      created_at: 1,
      updated_at: 1,
    });
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.default_model",
        { method: "DELETE" },
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.rows.has("org-1:agent.default_model")).toBe(false);
  });

  it("returns 404 when the row doesn't exist", async () => {
    asUser();
    const res = await buildApp().fetch(
      new Request(
        "https://agent.example/dashboard/api/settings/agent.default_model",
        { method: "DELETE" },
      ),
      makeEnv(new SettingsD1()),
      makeExecCtx(),
    );
    expect(res.status).toBe(404);
  });
});
