import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp, type Env } from "../src/index";
import { FakeD1 } from "./helpers/fake-d1";

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

function makeEnv(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
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
    PROJECT_MAPPINGS_JSON: "{}",
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

function authed(req: Request, token = "admin-secret"): Request {
  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(req, { headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/admin guard", () => {
  it("returns 403 when ADMIN_TOKEN is unset", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      new Request("https://agent.example/admin/projects"),
      makeEnv(db, { ADMIN_TOKEN: undefined }),
      makeExecCtx(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin_disabled" });
  });

  it("returns 401 when bearer doesn't match", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      authed(new Request("https://agent.example/admin/projects"), "wrong"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });
});

describe("/admin/projects CRUD", () => {
  it("POST validates required fields", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      authed(
        new Request("https://agent.example/admin/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ team_id: "" }),
        }),
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("POST upserts a project and returns it", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      authed(
        new Request("https://agent.example/admin/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            team_id: "team-1",
            repo_url: "https://github.com/x/y.git",
            max_turns: 5,
          }),
        }),
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect((json.project as { max_turns: number }).max_turns).toBe(5);
  });

  it("GET lists existing projects", async () => {
    const app = buildApp();
    const db = new FakeD1();
    db.projects.set("team-1", {
      team_id: "team-1",
      repo_url: "https://github.com/x/y.git",
      default_branch: "main",
      engine: "pi",
      model: null,
      max_turns: 10,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const res = await app.fetch(
      authed(new Request("https://agent.example/admin/projects")),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { projects: Array<{ team_id: string }> };
    expect(json.projects).toHaveLength(1);
    expect(json.projects[0]?.team_id).toBe("team-1");
  });

  it("DELETE removes a project row", async () => {
    const app = buildApp();
    const db = new FakeD1();
    db.projects.set("team-1", {
      team_id: "team-1",
      repo_url: "https://github.com/x/y.git",
      default_branch: "main",
      engine: "pi",
      model: null,
      max_turns: 10,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const res = await app.fetch(
      authed(
        new Request("https://agent.example/admin/projects/team-1", {
          method: "DELETE",
        }),
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.projects.has("team-1")).toBe(false);
  });
});

describe("/admin/installations", () => {
  it("returns installations without leaking access tokens", async () => {
    const app = buildApp();
    const db = new FakeD1();
    db.installations.set("org-1", {
      organization_id: "org-1",
      access_token: "SUPER_SECRET",
      scopes: "read,write",
      installed_at: "2026-01-01T00:00:00Z",
      refreshed_at: "2026-01-01T00:00:00Z",
    });

    const res = await app.fetch(
      authed(new Request("https://agent.example/admin/installations")),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      installations: Array<Record<string, unknown>>;
    };
    expect(json.installations).toHaveLength(1);
    expect(json.installations[0]).not.toHaveProperty("access_token");
    expect(json.installations[0]).toMatchObject({
      organization_id: "org-1",
      scopes: "read,write",
    });
  });
});

describe("D1-driven project resolution (integration via workflow path)", () => {
  it("project row's max_turns overrides DEFAULT_MAX_TURNS in resolve-inputs", async () => {
    // Smoke-test by hitting the admin route to seed a project then
    // confirming get() returns the override. The workflow itself is
    // covered in workflow.test.ts.
    const app = buildApp();
    const db = new FakeD1();
    await app.fetch(
      authed(
        new Request("https://agent.example/admin/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            team_id: "team-override",
            repo_url: "https://github.com/x/y.git",
            max_turns: 1,
          }),
        }),
      ),
      makeEnv(db),
      makeExecCtx(),
    );
    const row = db.projects.get("team-override");
    expect(row?.max_turns).toBe(1);
  });
});
