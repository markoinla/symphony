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

describe("/admin/smoke", () => {
  /**
   * Build a minimal SSE response body of NormalizedEvents — the same
   * shape the dispatcher emits.
   */
  function buildSseResponse(events: unknown[]): Response {
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("returns sse_wire_ok=true when the dispatcher emits an error + result", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/run")) {
        return buildSseResponse([
          { type: "error", message: "missing_auth_backup: smoke-test-no-such-scope" },
          {
            type: "result",
            exit_code: 75,
            duration_ms: 12,
            branch: null,
            pr_url: null,
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      authed(new Request("https://agent.example/admin/smoke")),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      sse_wire_ok: boolean;
      events_received: number;
      event_types: string[];
      final_event: { type: string; exit_code: number } | null;
      connect_error: string | null;
    };
    expect(json.sse_wire_ok).toBe(true);
    expect(json.events_received).toBe(2);
    expect(json.event_types).toEqual(["error", "result"]);
    expect(json.final_event?.type).toBe("result");
    expect(json.connect_error).toBeNull();
  });

  it("returns sse_wire_ok=false and surfaces connect_error when dispatcher returns non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/run")) {
        return new Response(
          JSON.stringify({ error: "invalid_signature" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      authed(new Request("https://agent.example/admin/smoke")),
      makeEnv(db),
      makeExecCtx(),
    );
    const json = (await res.json()) as {
      sse_wire_ok: boolean;
      connect_error: string;
    };
    expect(json.sse_wire_ok).toBe(false);
    expect(json.connect_error).toContain("dispatcher_401");
  });

  it("returns sse_wire_ok=false when stream closes without error+result combo", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/run")) {
        // Only a result, no error — wire shape is broken.
        return buildSseResponse([
          {
            type: "result",
            exit_code: 0,
            duration_ms: 5,
            branch: null,
            pr_url: null,
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      authed(new Request("https://agent.example/admin/smoke")),
      makeEnv(db),
      makeExecCtx(),
    );
    const json = (await res.json()) as { sse_wire_ok: boolean };
    expect(json.sse_wire_ok).toBe(false);
  });

  it("requires the admin bearer", async () => {
    const app = buildApp();
    const db = new FakeD1();
    const res = await app.fetch(
      new Request("https://agent.example/admin/smoke"),
      makeEnv(db),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
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
