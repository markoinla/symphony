import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp, type Env } from "../src/index";
import { computeLinearSignature } from "../src/lib/signature";
import { runSession, summarizeStdout } from "../src/routes/webhook";
import type { AgentSessionEventWebhook } from "../src/types/agent-session";
import { FakeD1 } from "./helpers/fake-d1";

/**
 * Captured Linear `agentActivityCreate` mutations for the current test.
 * Populated by the `installFetchMock` helper, which routes:
 *   - https://api.linear.app/graphql  → push to linearCalls, return success
 *   - <DISPATCHER_URL>/run            → return canned dispatcher result
 */
const linearCalls: Array<{
  agentSessionId: string;
  content: { type: string; body?: string; action?: string };
}> = [];

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

/**
 * Stub Workflow binding shaped like Cloudflare's `Workflow` type. Tests
 * that exercise the webhook handler should pass `sessionRunner` from
 * `makeWorkflowStub()` so they can assert on `.create` invocations.
 */
interface WorkflowStub {
  create: ReturnType<typeof vi.fn>;
}

function makeWorkflowStub(): WorkflowStub {
  return {
    create: vi.fn().mockResolvedValue({ id: "stub-instance" }),
  };
}

function makeEnv(
  kv: FakeKV,
  overrides: Partial<Env> = {},
  sessionRunner: WorkflowStub = makeWorkflowStub(),
  db: FakeD1 = new FakeD1(),
): Env {
  return {
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
    PROJECT_MAPPINGS_JSON: JSON.stringify({
      "team-abc": "https://github.com/markoinla/symphony.git",
    }),
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

beforeEach(() => {
  linearCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Install a fetch spy that recognizes Linear's GraphQL endpoint and the
 * dispatcher /run endpoint, routing each to the right canned response.
 *
 * `dispatcherResponse` is the JSON body the dispatcher should return for
 * /run. Linear GraphQL calls always return success and are pushed into
 * `linearCalls` so tests can assert on them.
 */
function installFetchMock(dispatcherResponse: {
  status?: number;
  body: unknown;
}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = init?.body as string | undefined;

    if (url === "https://api.linear.app/graphql") {
      if (body) {
        const parsed = JSON.parse(body) as {
          variables?: { input?: { agentSessionId: string; content: { type: string; body?: string; action?: string } } };
        };
        const input = parsed.variables?.input;
        if (input) linearCalls.push(input);
      }
      return new Response(
        JSON.stringify({ data: { agentActivityCreate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/run")) {
      return new Response(JSON.stringify(dispatcherResponse.body), {
        status: dispatcherResponse.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

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
      params: { event },
    });

    const res2 = await app.fetch(await signedWebhookRequest(event), env, makeExecCtx());
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true, deduped: true });
    expect(sessionRunner.create).toHaveBeenCalledTimes(1);
  });

  it("treats workflow 'instance already exists' as success", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner: WorkflowStub = {
      create: vi
        .fn()
        .mockRejectedValueOnce(new Error("instance with id 'session-x' already exists")),
    };

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "prompted",
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

describe("runSession", () => {
  it("posts thought + response on a successful dispatcher run", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    db.installations.set("org-1", {
      organization_id: "org-1",
      access_token: "fake-token",
      scopes: "read,write",
      installed_at: new Date().toISOString(),
      refreshed_at: new Date().toISOString(),
    });

    installFetchMock({
      body: {
        engine: "pi",
        exit_code: 0,
        stdout: [
          '{"type":"session","id":"x"}',
          '{"type":"agent_start"}',
          '{"type":"turn_start"}',
          '{"type":"message_start","message":{"role":"user","content":[]}}',
          '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Add the date to README"}]}}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done — opened PR #123."}]}}',
          '{"type":"agent_end"}',
        ].join("\n"),
        stderr: "",
        duration_ms: 4567,
      },
    });

    await runSession(makeEnv(kv, {}, undefined, db), {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-2",
      organizationId: "org-1",
      agentSession: {
        id: "session-2",
        issue: {
          id: "issue-2",
          identifier: "SYM-200",
          title: "Add date to README",
          teamId: "team-abc",
        },
        promptContext: "Please add today's date to README.md",
      },
    });

    expect(linearCalls).toHaveLength(2);
    expect(linearCalls[0]).toEqual({
      agentSessionId: "session-2",
      content: {
        type: "thought",
        body: "Picked this up — preparing the sandbox. Cold-starts can take ~30–60s before tool activity begins streaming.",
      },
    });
    expect(linearCalls[1]).toEqual({
      agentSessionId: "session-2",
      content: { type: "response", body: "Done — opened PR #123." },
    });
  });

  it("posts thought + error when no repo is configured for the team", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    db.installations.set("org-1", {
      organization_id: "org-1",
      access_token: "fake-token",
      scopes: "read,write",
      installed_at: new Date().toISOString(),
      refreshed_at: new Date().toISOString(),
    });
    const env = makeEnv(kv, { PROJECT_MAPPINGS_JSON: "{}" }, undefined, db);

    // Even the initial `thought` post hits Linear's GraphQL now that we
    // bypassed the SDK; install a mock so the post resolves and the
    // subsequent error flow proceeds.
    installFetchMock({ body: { error: "should-not-be-called" } });

    await runSession(env, {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-3",
      organizationId: "org-1",
      agentSession: {
        id: "session-3",
        issue: {
          id: "i",
          identifier: "SYM-1",
          title: "x",
          teamId: "team-unknown",
        },
        promptContext: "hi",
      },
    });

    expect(linearCalls.map((c) => c.content.type)).toEqual(["thought", "error"]);
    expect(linearCalls[1]?.content.body).toContain("No repository is configured");
  });

  it("posts thought + error when the dispatcher returns 412", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    db.installations.set("org-1", {
      organization_id: "org-1",
      access_token: "fake-token",
      scopes: "read,write",
      installed_at: new Date().toISOString(),
      refreshed_at: new Date().toISOString(),
    });

    installFetchMock({
      status: 412,
      body: { error: "missing_auth_backup", scope: "default" },
    });

    await runSession(makeEnv(kv, {}, undefined, db), {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-4",
      organizationId: "org-1",
      agentSession: {
        id: "session-4",
        issue: {
          id: "i",
          identifier: "SYM-4",
          title: "x",
          teamId: "team-abc",
        },
        promptContext: "hi",
      },
    });

    expect(linearCalls.map((c) => c.content.type)).toEqual(["thought", "error"]);
    expect(linearCalls[1]?.content.body).toContain("Dispatcher error (412)");
    expect(linearCalls[1]?.content.body).toContain("missing_auth_backup");
  });

  it("posts thought + error when the engine exits non-zero", async () => {
    const kv = new FakeKV();
    const db = new FakeD1();
    db.installations.set("org-1", {
      organization_id: "org-1",
      access_token: "fake-token",
      scopes: "read,write",
      installed_at: new Date().toISOString(),
      refreshed_at: new Date().toISOString(),
    });

    installFetchMock({
      body: {
        engine: "pi",
        exit_code: 2,
        stdout: "",
        stderr: "ENOENT: codex auth missing",
        duration_ms: 100,
      },
    });

    await runSession(makeEnv(kv, {}, undefined, db), {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-5",
      organizationId: "org-1",
      agentSession: {
        id: "session-5",
        issue: {
          id: "i",
          identifier: "SYM-5",
          title: "x",
          teamId: "team-abc",
        },
        promptContext: "hi",
      },
    });

    expect(linearCalls.map((c) => c.content.type)).toEqual(["thought", "error"]);
    expect(linearCalls[1]?.content.body).toContain("Engine exited with code 2");
    expect(linearCalls[1]?.content.body).toContain("ENOENT");
  });

  it("returns silently when no installation is configured", async () => {
    const kv = new FakeKV();

    await runSession(makeEnv(kv), {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-6",
      agentSession: {
        id: "session-6",
        promptContext: "hi",
      },
    });

    expect(linearCalls).toHaveLength(0);
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

