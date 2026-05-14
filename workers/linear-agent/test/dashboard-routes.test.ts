import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireOrgMock } = vi.hoisted(() => ({ requireOrgMock: vi.fn() }));

vi.mock("../src/lib/dashboard-auth", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/lib/dashboard-auth")
  >();
  return { ...actual, requireOrg: requireOrgMock };
});

import { buildApp, type Env } from "../src/index";
import { FakeD1 } from "./helpers/fake-d1";

class FakeKV {
  async get() {
    return null;
  }
  async put() {}
  async delete() {}
}

function makeEnv(db: FakeD1): Env {
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

beforeEach(() => {
  requireOrgMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dashboard session routes", () => {
  it("returns Linear issue identifiers separately from titles and normalizes timestamps", async () => {
    asUser();
    const db = new FakeD1();
    db.agentSessions.set("session-1", {
      id: "session-1",
      organization_id: "org-1",
      project_id: null,
      linear_issue_id: "linear-graphql-id",
      linear_issue_identifier: "SYM-359",
      linear_issue_title: "Fix dashboard session identifiers and timestamp normalization",
      status: "complete",
      started_at: 1_700_000_000,
      completed_at: 1_700_000_600,
      triggered_by: "created",
      team: "SYM",
      repo: "https://github.com/markoinla/symphony",
      prompt: null,
      config_snapshot: null,
      stderr: null,
      dispatcher_logs: null,
      messages: null,
      error: null,
    });

    const res = await buildApp().fetch(
      new Request("https://agent.example/dashboard/api/sessions"),
      makeEnv(db),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        id: string;
        linear_issue_identifier: string | null;
        linear_issue_title: string | null;
        started_at: string | null;
        completed_at: string | null;
      }>;
    };
    expect(body.sessions[0]).toMatchObject({
      id: "session-1",
      linear_issue_identifier: "SYM-359",
      linear_issue_title:
        "Fix dashboard session identifiers and timestamp normalization",
      started_at: "2023-11-14T22:13:20.000Z",
      completed_at: "2023-11-14T22:23:20.000Z",
    });
    expect(new Date(body.sessions[0]!.started_at!).getUTCFullYear()).toBe(2023);
  });

  it("debug payloads use the same normalized timestamps and issue key", async () => {
    asUser();
    const db = new FakeD1();
    db.agentSessions.set("session-2", {
      id: "session-2",
      organization_id: "org-1",
      project_id: null,
      linear_issue_id: "linear-graphql-id",
      linear_issue_identifier: "SYM-360",
      linear_issue_title: "Human editable title",
      status: "running",
      started_at: 1_700_100_000,
      completed_at: null,
      triggered_by: "created",
      team: "SYM",
      repo: "https://github.com/markoinla/symphony",
      prompt: null,
      config_snapshot: null,
      stderr: null,
      dispatcher_logs: null,
      messages: null,
      error: null,
    });

    const res = await buildApp().fetch(
      new Request("https://agent.example/dashboard/api/sessions/session-2/debug"),
      makeEnv(db),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      linear_issue_identifier: string | null;
      started_at: string | null;
      completed_at: string | null;
    };
    expect(body.linear_issue_identifier).toBe("SYM-360");
    expect(body.started_at).toBe("2023-11-16T02:00:00.000Z");
    expect(body.completed_at).toBeNull();
  });
});
