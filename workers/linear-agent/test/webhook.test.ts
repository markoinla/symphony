import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp, type Env } from "../src/index";
import { computeLinearSignature } from "../src/lib/signature";
import { summarizeStdout } from "../src/routes/webhook";
import type { AgentSessionEventWebhook } from "../src/types/agent-session";
import { FakeD1 } from "./helpers/fake-d1";

const LINEAR_SECRET = "linear-webhook-secret";
const HMAC_SECRET = "dispatch-hmac-secret";

class FakeKV {
  store = new Map<string, string>();

  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, _opts?: unknown) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

interface WorkflowInstanceStub {
  status: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

interface WorkflowStub {
  create: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
}

function makeWorkflowStub(): WorkflowStub {
  return {
    create: vi.fn().mockResolvedValue({ id: "stub-instance" }),
  };
}

function makeInstanceStub(
  overrides: Partial<WorkflowInstanceStub> = {},
): WorkflowInstanceStub {
  return {
    status: overrides.status ?? vi.fn().mockResolvedValue({ status: "running" }),
    sendEvent: overrides.sendEvent ?? vi.fn().mockResolvedValue(undefined),
    terminate: overrides.terminate ?? vi.fn().mockResolvedValue(undefined),
  };
}

function makeEnv(
  kv: FakeKV,
  overrides: Partial<Env> = {},
  sessionRunner: WorkflowStub = makeWorkflowStub(),
  db: FakeD1 = new FakeD1(),
): Env {
  return {
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    LINEAR_TOKENS: kv as unknown as KVNamespace,
    SESSION_RUNNER: sessionRunner as unknown as Workflow,
    DB: db as unknown as D1Database,
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
    LINEAR_WEBHOOK_SECRET: LINEAR_SECRET,
    DISPATCHER_URL: "https://dispatcher.example",
    DISPATCH_HMAC_SECRET: HMAC_SECRET,
    URL: "https://agent.example",
    DEFAULT_SCOPE: "default",
    DEFAULT_MODEL: "anthropic/claude-sonnet-4-6",
    DEFAULT_ENGINE: "pi",
    ...overrides,
  };
}

async function signedWebhookRequest(
  body: AgentSessionEventWebhook | Record<string, unknown>,
): Promise<Request> {
  const raw = JSON.stringify(body);
  const sig = await computeLinearSignature(LINEAR_SECRET, raw);
  return new Request("https://agent.example/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "linear-signature": sig,
    },
    body: raw,
  });
}

function makeExecCtx(): ExecutionContext & {
  pending: Promise<unknown>[];
  flush: () => Promise<void>;
} {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
    pending,
    async flush() {
      await Promise.all(pending);
    },
  } as unknown as ExecutionContext & {
    pending: Promise<unknown>[];
    flush: () => Promise<void>;
  };
}

beforeEach(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /webhook signature verification", () => {
  it("rejects requests with no linear-signature header", async () => {
    const app = buildApp();
    const kv = new FakeKV();

    const res = await app.fetch(
      new Request("https://agent.example/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "AgentSessionEvent" }),
      }),
      makeEnv(kv),
      makeExecCtx(),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
  });

  it("rejects requests with a wrong signature", async () => {
    const app = buildApp();
    const kv = new FakeKV();

    const res = await app.fetch(
      new Request("https://agent.example/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "linear-signature": "deadbeef",
        },
        body: JSON.stringify({ type: "AgentSessionEvent" }),
      }),
      makeEnv(kv),
      makeExecCtx(),
    );

    expect(res.status).toBe(401);
  });
});

describe("POST /webhook routing", () => {
  it("ignores non-AgentSessionEvent webhooks", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const ctx = makeExecCtx();

    const req = await signedWebhookRequest({ type: "Issue", action: "create" });
    const res = await app.fetch(req, makeEnv(kv), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(ctx.pending).toHaveLength(0);
  });

  it("dedupes repeated deliveries on (webhookId, agentSession.id)", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner = makeWorkflowStub();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-1",
      agentSession: { id: "session-1", promptContext: "do it" },
    };

    const env = makeEnv(kv, {}, sessionRunner);

    const res1 = await app.fetch(await signedWebhookRequest(event), env, makeExecCtx());
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ ok: true, scheduled: true });
    expect(sessionRunner.create).toHaveBeenCalledTimes(1);
    expect(sessionRunner.create).toHaveBeenCalledWith({
      id: "session-1",
      params: { mode: "agent_session", event },
    });

    const res2 = await app.fetch(await signedWebhookRequest(event), env, makeExecCtx());
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true, deduped: true });
    expect(sessionRunner.create).toHaveBeenCalledTimes(1);
  });

  it("treats workflow 'instance already exists' as success on `created` action", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner: WorkflowStub = {
      create: vi
        .fn()
        .mockRejectedValueOnce(new Error("instance with id 'session-x' already exists")),
    };

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-2",
      agentSession: { id: "session-x", promptContext: "again" },
    };

    const res = await app.fetch(
      await signedWebhookRequest(event),
      makeEnv(kv, {}, sessionRunner),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scheduled: true });
  });

  it("ignores actions other than created/prompted", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const ctx = makeExecCtx();

    const res = await app.fetch(
      await signedWebhookRequest({
        type: "AgentSessionEvent",
        action: "completed",
        webhookId: "wh-99",
        agentSession: { id: "session-99" },
      }),
      makeEnv(kv),
      ctx,
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ignored: true,
      action: "completed",
    });
    expect(ctx.pending).toHaveLength(0);
  });
});

describe("POST /webhook prompted follow-ups", () => {
  it("forwards prompted events to running instances via sendEvent (no create)", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const instance = makeInstanceStub({
      status: vi.fn().mockResolvedValue({ status: "running" }),
    });
    const sessionRunner: WorkflowStub = {
      create: vi.fn().mockResolvedValue({ id: "stub-instance" }),
      get: vi.fn().mockResolvedValue(instance),
    };

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "prompted",
      webhookId: "wh-prompt-1",
      agentSession: { id: "session-running", promptContext: "follow-up" },
    };

    const res = await app.fetch(
      await signedWebhookRequest(event),
      makeEnv(kv, {}, sessionRunner),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      forwarded: true,
    });
    expect(sessionRunner.get).toHaveBeenCalledWith("session-running");
    expect(instance.sendEvent).toHaveBeenCalledTimes(1);
    expect(instance.sendEvent).toHaveBeenCalledWith({
      type: "linear.prompted",
      payload: event,
    });
    expect(sessionRunner.create).not.toHaveBeenCalled();
  });

  it("forwards prompted events to waiting instances via sendEvent", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const instance = makeInstanceStub({
      status: vi.fn().mockResolvedValue({ status: "waiting" }),
    });
    const sessionRunner: WorkflowStub = {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(instance),
    };

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "prompted",
      webhookId: "wh-prompt-2",
      agentSession: { id: "session-waiting", promptContext: "follow-up 2" },
    };

    const res = await app.fetch(
      await signedWebhookRequest(event),
      makeEnv(kv, {}, sessionRunner),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect(instance.sendEvent).toHaveBeenCalledTimes(1);
    expect(sessionRunner.create).not.toHaveBeenCalled();
  });

  it("spawns a fresh instance with a :rN id when the prior session is complete", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const instance = makeInstanceStub({
      status: vi.fn().mockResolvedValue({ status: "complete" }),
    });
    const sessionRunner: WorkflowStub = {
      create: vi.fn().mockResolvedValue({ id: "stub-instance" }),
      get: vi.fn().mockResolvedValue(instance),
    };

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "prompted",
      webhookId: "wh-prompt-3",
      agentSession: { id: "session-done", promptContext: "wake up" },
    };

    const res = await app.fetch(
      await signedWebhookRequest(event),
      makeEnv(kv, {}, sessionRunner),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, scheduled: true });
    expect(typeof body.resume_id).toBe("string");
    expect(body.resume_id as string).toMatch(/^session-done:r\d+$/);
    expect(instance.sendEvent).not.toHaveBeenCalled();
    expect(sessionRunner.create).toHaveBeenCalledTimes(1);
    const createArgs = sessionRunner.create.mock.calls[0]![0] as {
      id: string;
      params: unknown;
    };
    expect(createArgs.id).toMatch(/^session-done:r\d+$/);
    expect(createArgs.params).toEqual({ mode: "agent_session", event });
  });

  it("spawns a fresh instance when get() rejects (instance never existed)", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner: WorkflowStub = {
      create: vi.fn().mockResolvedValue({ id: "stub-instance" }),
      get: vi.fn().mockRejectedValue(new Error("instance not found")),
    };

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "prompted",
      webhookId: "wh-prompt-4",
      agentSession: { id: "session-ghost", promptContext: "hi?" },
    };

    const res = await app.fetch(
      await signedWebhookRequest(event),
      makeEnv(kv, {}, sessionRunner),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect(sessionRunner.create).toHaveBeenCalledTimes(1);
    const createArgs = sessionRunner.create.mock.calls[0]![0] as { id: string };
    expect(createArgs.id).toMatch(/^session-ghost:r\d+$/);
  });
});

describe("POST /webhook stop signal", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function seedInstall(db: FakeD1): { orgId: string; linearOrgId: string } {
    const orgId = "org-uuid-stop";
    const linearOrgId = "linear-org-stop";
    const now = Math.floor(Date.now() / 1000);
    db.linearAgentInstalls.set(orgId, {
      id: "install-stop-1",
      organization_id: orgId,
      linear_organization_id: linearOrgId,
      access_token: "stop-token",
      refresh_token: null,
      scopes: "read,write",
      installed_by_user_id: "user-1",
      status: "active",
      installed_at: now,
      refreshed_at: now,
      expires_at: null,
    });
    return { orgId, linearOrgId };
  }

  function seedSession(db: FakeD1, sessionId: string, orgId: string): void {
    const now = Math.floor(Date.now() / 1000);
    db.agentSessions.set(sessionId, {
      id: sessionId,
      organization_id: orgId,
      project_id: null,
      linear_issue_id: null,
      linear_issue_title: null,
      status: "running",
      started_at: now,
      completed_at: null,
      triggered_by: "created",
      team: null,
      repo: null,
      prompt: null,
      config_snapshot: null,
      stderr: null,
      dispatcher_logs: null,
      messages: null,
      error: null,
    });
  }

  it("terminates the runner, stops the sandbox, posts a final response, and marks status=stopped", async () => {
    const dispatcherCalls: Array<{ url: string; body: unknown }> = [];
    const linearGraphqlCalls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.includes("/run/stop")) {
        dispatcherCalls.push({ url, body });
        return new Response("{}", { status: 200 });
      }
      if (url === "https://api.linear.app/graphql") {
        linearGraphqlCalls.push({ url, body });
        return new Response(
          JSON.stringify({ data: { agentActivityCreate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const app = buildApp();
    const kv = new FakeKV();
    const db = new FakeD1();
    const { orgId, linearOrgId } = seedInstall(db);
    const sessionId = "session-to-stop";
    seedSession(db, sessionId, orgId);

    const instance = makeInstanceStub({
      status: vi.fn().mockResolvedValue({ status: "running" }),
    });
    const sessionRunner: WorkflowStub = {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(instance),
    };

    const event = {
      type: "AgentSessionEvent",
      action: "prompted",
      webhookId: "wh-stop-1",
      organizationId: linearOrgId,
      agentSession: {
        id: sessionId,
        issue: { id: "issue-1", identifier: "STP-1", title: "halt me" },
      },
      agentActivity: { signal: "stop" },
    };

    const res = await app.fetch(
      await signedWebhookRequest(event),
      makeEnv(kv, {}, sessionRunner, db),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      stopped: true,
    });

    // Workflow instance terminated.
    expect(instance.terminate).toHaveBeenCalledTimes(1);

    // Dispatcher was told to stop the per-issue sandbox.
    expect(dispatcherCalls.length).toBe(1);
    expect((dispatcherCalls[0]!.body as { issue_id: string }).issue_id).toBe(
      "STP-1",
    );

    // Final `response` activity posted to Linear.
    expect(linearGraphqlCalls.length).toBe(1);
    const activityBody = linearGraphqlCalls[0]!.body as {
      variables: { input: { agentSessionId: string; content: Record<string, unknown> } };
    };
    expect(activityBody.variables.input).toEqual({
      agentSessionId: sessionId,
      content: { type: "response", body: "Stopped at user request." },
    });

    // agent_sessions row reflects the stop.
    const sessionRow = db.agentSessions.get(sessionId);
    expect(sessionRow?.status).toBe("stopped");
    expect(sessionRow?.completed_at).toBeTypeOf("number");
  });

  it("detects signal nested under data.agentActivity", async () => {
    const dispatcherCalls: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/run/stop")) {
        dispatcherCalls.push(url);
        return new Response("{}", { status: 200 });
      }
      if (url === "https://api.linear.app/graphql") {
        return new Response(
          JSON.stringify({ data: { agentActivityCreate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const app = buildApp();
    const kv = new FakeKV();
    const db = new FakeD1();
    const { linearOrgId } = seedInstall(db);
    const sessionId = "session-stop-nested";
    seedSession(db, sessionId, "org-uuid-stop");

    const instance = makeInstanceStub();
    const sessionRunner: WorkflowStub = {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(instance),
    };

    const event = {
      type: "AgentSessionEvent",
      action: "prompted",
      webhookId: "wh-stop-2",
      organizationId: linearOrgId,
      agentSession: {
        id: sessionId,
        issue: { id: "issue-2", identifier: "STP-2", title: "halt nested" },
      },
      data: { agentActivity: { signal: "stop" } },
    };

    const res = await app.fetch(
      await signedWebhookRequest(event),
      makeEnv(kv, {}, sessionRunner, db),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect(instance.terminate).toHaveBeenCalledTimes(1);
    expect(dispatcherCalls.length).toBe(1);
  });
});

describe("summarizeStdout", () => {
  it("returns the last assistant message_end text", () => {
    const stdout = [
      '{"type":"session","id":"x"}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first answer"}]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}]}}',
    ].join("\n");
    expect(summarizeStdout(stdout)).toBe("final answer");
  });

  it("ignores user-role message_end events", () => {
    const stdout = [
      '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"prompt"}]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"reply"}]}}',
    ].join("\n");
    expect(summarizeStdout(stdout)).toBe("reply");
  });

  it("falls back to text_delta reconstruction when no message_end has text", () => {
    const stdout = [
      '{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello "}}',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"world."}}',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_end"}}',
    ].join("\n");
    expect(summarizeStdout(stdout)).toBe("Hello world.");
  });

  it("falls back to truncated stdout when nothing parses", () => {
    expect(summarizeStdout("not json at all")).toBe("not json at all");
  });

  it("skips invalid JSON lines without crashing", () => {
    const stdout = [
      "garbage line",
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
      "more garbage",
    ].join("\n");
    expect(summarizeStdout(stdout)).toBe("ok");
  });
});
