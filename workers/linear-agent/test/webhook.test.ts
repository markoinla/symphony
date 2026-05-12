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
