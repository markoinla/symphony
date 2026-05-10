import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the @linear/sdk LinearClient before importing the route — the
// activity helpers go through it. We only assert that
// `createAgentActivity` is called with the right shape.
const linearCalls: Array<{
  agentSessionId: string;
  content: { type: string; body?: string; action?: string };
}> = [];

vi.mock("@linear/sdk", () => {
  return {
    LinearClient: vi.fn().mockImplementation(() => ({
      createAgentActivity: vi.fn(async (input: {
        agentSessionId: string;
        content: { type: string; body?: string; action?: string };
      }) => {
        linearCalls.push(input);
        return { success: true };
      }),
    })),
  };
});

import { buildApp, type Env } from "../src/index";
import { computeLinearSignature } from "../src/lib/signature";
import { runSession } from "../src/routes/webhook";
import type { AgentSessionEventWebhook } from "../src/types/agent-session";

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

function makeEnv(kv: FakeKV, overrides: Partial<Env> = {}): Env {
  return {
    LINEAR_TOKENS: kv as unknown as KVNamespace,
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
  vi.clearAllMocks();
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

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-1",
      agentSession: { id: "session-1", promptContext: "do it" },
    };

    const ctx1 = makeExecCtx();
    const res1 = await app.fetch(await signedWebhookRequest(event), makeEnv(kv), ctx1);
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ ok: true, scheduled: true });
    expect(ctx1.pending).toHaveLength(1);

    const ctx2 = makeExecCtx();
    const res2 = await app.fetch(await signedWebhookRequest(event), makeEnv(kv), ctx2);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true, deduped: true });
    expect(ctx2.pending).toHaveLength(0);
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
    await kv.put("access_token", "fake-token");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          engine: "pi",
          exit_code: 0,
          stdout:
            '{"type":"thought","body":"thinking"}\n{"type":"response","body":"Done — opened PR #123."}\n',
          stderr: "",
          duration_ms: 4567,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      await runSession(makeEnv(kv), {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "wh-2",
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
    } finally {
      fetchSpy.mockRestore();
    }

    expect(linearCalls).toHaveLength(2);
    expect(linearCalls[0]).toEqual({
      agentSessionId: "session-2",
      content: { type: "thought", body: "Picked this up — working on it." },
    });
    expect(linearCalls[1]).toEqual({
      agentSessionId: "session-2",
      content: { type: "response", body: "Done — opened PR #123." },
    });
  });

  it("posts thought + error when no repo is configured for the team", async () => {
    const kv = new FakeKV();
    await kv.put("access_token", "fake-token");
    const env = makeEnv(kv, { PROJECT_MAPPINGS_JSON: "{}" });

    await runSession(env, {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-3",
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
    await kv.put("access_token", "fake-token");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "missing_auth_backup", scope: "default" }),
        { status: 412, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      await runSession(makeEnv(kv), {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "wh-4",
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
    } finally {
      fetchSpy.mockRestore();
    }

    expect(linearCalls.map((c) => c.content.type)).toEqual(["thought", "error"]);
    expect(linearCalls[1]?.content.body).toContain("Dispatcher error (412)");
    expect(linearCalls[1]?.content.body).toContain("missing_auth_backup");
  });

  it("posts thought + error when the engine exits non-zero", async () => {
    const kv = new FakeKV();
    await kv.put("access_token", "fake-token");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          engine: "pi",
          exit_code: 2,
          stdout: "",
          stderr: "ENOENT: codex auth missing",
          duration_ms: 100,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      await runSession(makeEnv(kv), {
        type: "AgentSessionEvent",
        action: "created",
        webhookId: "wh-5",
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
    } finally {
      fetchSpy.mockRestore();
    }

    expect(linearCalls.map((c) => c.content.type)).toEqual(["thought", "error"]);
    expect(linearCalls[1]?.content.body).toContain("Engine exited with code 2");
    expect(linearCalls[1]?.content.body).toContain("ENOENT");
  });

  it("returns silently when no access_token is configured", async () => {
    const kv = new FakeKV();
    // No access_token put.

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
