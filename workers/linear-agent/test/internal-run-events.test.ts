import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the Linear activity client — the linear-attached path posts via
// `buildActivityClient`; we assert on the spy instead of hitting the
// Linear GraphQL API.
const { createAgentActivityMock } = vi.hoisted(() => ({
  createAgentActivityMock: vi.fn(async () => ({ success: true })),
}));

vi.mock("../src/lib/activities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/activities")>();
  return {
    ...actual,
    buildActivityClient: vi.fn(() => ({
      createAgentActivity: createAgentActivityMock,
    })),
  };
});

import { buildApp, type Env } from "../src/index";
import { computeHmacSignature } from "../src/lib/signature";
import { FakeD1, type AgentSessionRow } from "./helpers/fake-d1";

const HMAC_SECRET = "hmac-secret";

class FakeKV {
  async get() {
    return null;
  }
  async put() {}
  async delete() {}
}

function makeEnv(db: FakeD1, sessionRunner: unknown): Env {
  return {
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    LINEAR_TOKENS: new FakeKV() as unknown as KVNamespace,
    SESSION_RUNNER: sessionRunner as Workflow,
    DB: db as unknown as D1Database,
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
    LINEAR_WEBHOOK_SECRET: "wh-secret",
    DISPATCHER_URL: "https://dispatcher.example",
    DISPATCH_HMAC_SECRET: HMAC_SECRET,
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

/** A SESSION_RUNNER stub whose `get(id)` returns an instance with a
 *  spyable `sendEvent`. */
function makeSessionRunner() {
  const sendEvent = vi.fn(async () => {});
  const get = vi.fn(async () => ({ sendEvent }));
  return { sendEvent, get, runner: { get, create: vi.fn() } };
}

function seedSession(
  db: FakeD1,
  overrides: Partial<AgentSessionRow> = {},
): string {
  const id = overrides.id ?? "session-1";
  db.agentSessions.set(id, {
    id,
    organization_id: "org-1",
    project_id: null,
    linear_issue_id: null,
    linear_issue_identifier: null,
    linear_issue_title: null,
    status: "running",
    started_at: 1_700_000_000,
    completed_at: null,
    triggered_by: "created",
    team: "SYM",
    repo: "https://github.com/x/y",
    prompt: null,
    config_snapshot: null,
    stderr: null,
    dispatcher_logs: null,
    messages: null,
    error: null,
    ...overrides,
  });
  return id;
}

const TOOL_LINE = JSON.stringify({
  type: "tool_execution_start",
  toolName: "bash",
  toolCallId: "t1",
  args: { cmd: "ls" },
});
const ASSISTANT_LINE = JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "All done." }] },
});

async function signBody(sessionId: string, rawBody: string): Promise<string> {
  const perRunToken = await computeHmacSignature(
    HMAC_SECRET,
    sessionId,
    "sha256",
  );
  return computeHmacSignature(perRunToken, rawBody, "sha256");
}

async function ingestRequest(
  sessionId: string,
  body: unknown,
  opts: { signature?: string; omitSignature?: boolean } = {},
): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!opts.omitSignature) {
    headers["x-symphony-signature"] =
      opts.signature ?? (await signBody(sessionId, rawBody));
  }
  return new Request(
    `https://agent.example/internal/run-events/${sessionId}`,
    { method: "POST", headers, body: rawBody },
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /internal/run-events/:sessionId — auth", () => {
  it("401s when the signature header is missing", async () => {
    const db = new FakeD1();
    seedSession(db);
    const res = await buildApp().fetch(
      await ingestRequest("session-1", { instance_id: "session-1", lines: [] }, {
        omitSignature: true,
      }),
      makeEnv(db, makeSessionRunner().runner),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("401s when the signature is computed with the wrong key", async () => {
    const db = new FakeD1();
    seedSession(db);
    const res = await buildApp().fetch(
      await ingestRequest(
        "session-1",
        { instance_id: "session-1", lines: [] },
        { signature: "deadbeef" },
      ),
      makeEnv(db, makeSessionRunner().runner),
      makeExecCtx(),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /internal/run-events/:sessionId — ingest", () => {
  it("404s for an unknown session", async () => {
    const db = new FakeD1();
    const res = await buildApp().fetch(
      await ingestRequest("missing", { instance_id: "missing", lines: [] }),
      makeEnv(db, makeSessionRunner().runner),
      makeExecCtx(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_session" });
  });

  it("400s when instance_id is missing", async () => {
    const db = new FakeD1();
    seedSession(db);
    const res = await buildApp().fetch(
      await ingestRequest("session-1", { lines: [] }),
      makeEnv(db, makeSessionRunner().runner),
      makeExecCtx(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_instance_id" });
  });

  it("normalizes raw pi lines and persists timeline rows", async () => {
    const db = new FakeD1();
    seedSession(db);
    const res = await buildApp().fetch(
      await ingestRequest("session-1", {
        instance_id: "session-1",
        lines: [TOOL_LINE, ASSISTANT_LINE],
      }),
      makeEnv(db, makeSessionRunner().runner),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      ingested: 2,
      terminal: false,
    });
    expect(db.agentSessionEvents.map((e) => e.type)).toEqual([
      "tool_call",
      "assistant_msg",
    ]);
    // assistant_msg is persisted untruncated (drives the terminal response).
    expect(db.agentSessionEvents[1]!.body).toBe("All done.");
  });

  it("persists forwarder heartbeat rows without posting Linear activity", async () => {
    const db = new FakeD1();
    seedSession(db, { linear_issue_id: "issue-1" });
    const res = await buildApp().fetch(
      await ingestRequest("session-1", {
        instance_id: "session-1",
        heartbeat: {
          phase: "engine_running",
          pid: 123,
          elapsed_ms: 60_000,
          timeout_ms: 2_100_000,
          stdout_bytes: 42,
          stderr_bytes: 7,
          last_stdout_at: 1_800_000_000_000,
          last_stderr_at: null,
          pending_lines: 0,
        },
      }),
      makeEnv(db, makeSessionRunner().runner),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      ingested: 0,
      heartbeat: true,
      terminal: false,
    });
    expect(db.agentSessionEvents).toHaveLength(1);
    expect(db.agentSessionEvents[0]).toMatchObject({
      type: "heartbeat",
      body: expect.stringContaining('"phase":"engine_running"'),
    });
    expect(createAgentActivityMock).not.toHaveBeenCalled();
  });

  it("rejects malformed heartbeat payloads", async () => {
    const db = new FakeD1();
    seedSession(db);
    const res = await buildApp().fetch(
      await ingestRequest("session-1", {
        instance_id: "session-1",
        heartbeat: { phase: "", elapsed_ms: -1 },
      }),
      makeEnv(db, makeSessionRunner().runner),
      makeExecCtx(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_heartbeat" });
  });

  it("skips Linear activity posts for headless (no linear_issue_id) sessions", async () => {
    const db = new FakeD1();
    seedSession(db, { linear_issue_id: null });
    await buildApp().fetch(
      await ingestRequest("session-1", {
        instance_id: "session-1",
        lines: [TOOL_LINE],
      }),
      makeEnv(db, makeSessionRunner().runner),
      makeExecCtx(),
    );
    expect(createAgentActivityMock).not.toHaveBeenCalled();
  });

  it("posts live Linear activities for linear-attached sessions", async () => {
    const db = new FakeD1();
    seedSession(db, { linear_issue_id: "issue-1" });
    db.linearAgentInstalls.set("org-1", {
      id: "install-1",
      organization_id: "org-1",
      linear_organization_id: "lin-org-1",
      access_token: "tok",
      refresh_token: null,
      scopes: "",
      installed_by_user_id: "u",
      status: "active",
      installed_at: 1_700_000_000,
      refreshed_at: 1_700_000_000,
      // Far-future expiry so the token is used as-is (no refresh fetch).
      expires_at: Math.floor(Date.now() / 1000) + 86_400,
    });
    await buildApp().fetch(
      await ingestRequest("session-1", {
        instance_id: "session-1",
        lines: [TOOL_LINE, ASSISTANT_LINE],
      }),
      makeEnv(db, makeSessionRunner().runner),
      makeExecCtx(),
    );
    // tool_call maps to an `action` activity; assistant_msg maps to null.
    expect(createAgentActivityMock).toHaveBeenCalledTimes(1);
    expect(createAgentActivityMock).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      content: expect.objectContaining({ type: "action", action: "bash" }),
    });
  });
});

describe("POST /internal/run-events/:sessionId — terminal", () => {
  it("wakes the workflow with exit status and the final message on a clean exit", async () => {
    const db = new FakeD1();
    seedSession(db);
    const sr = makeSessionRunner();
    const res = await buildApp().fetch(
      await ingestRequest("session-1", {
        instance_id: "session-1",
        lines: [TOOL_LINE, ASSISTANT_LINE],
        exit: { code: 0 },
      }),
      makeEnv(db, sr.runner),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ terminal: true, woke: true });
    // tool_call + assistant_msg + a synthetic result row.
    expect(db.agentSessionEvents.map((e) => e.type)).toEqual([
      "tool_call",
      "assistant_msg",
      "result",
    ]);
    expect(sr.get).toHaveBeenCalledWith("session-1");
    expect(sr.sendEvent).toHaveBeenCalledWith({
      type: "run-terminal",
      payload: {
        exit_code: 0,
        error: null,
        last_assistant: "All done.",
      },
    });
  });

  it("wakes the workflow with an error on a non-zero exit", async () => {
    const db = new FakeD1();
    seedSession(db);
    const sr = makeSessionRunner();
    await buildApp().fetch(
      await ingestRequest("session-1", {
        instance_id: "session-1",
        lines: [],
        exit: { code: 1, stderr_tail: "  pi: fatal error  " },
      }),
      makeEnv(db, sr.runner),
      makeExecCtx(),
    );
    expect(sr.sendEvent).toHaveBeenCalledWith({
      type: "run-terminal",
      payload: {
        exit_code: 1,
        error: "pi: fatal error",
        last_assistant: null,
      },
    });
  });

  it("targets the instance_id from the body, not the path session id", async () => {
    const db = new FakeD1();
    // A resume run: events persist under the original session id, but
    // the live workflow instance carries an `:rN` suffix.
    seedSession(db, { id: "session-1" });
    const sr = makeSessionRunner();
    await buildApp().fetch(
      await ingestRequest("session-1", {
        instance_id: "session-1:r1700000000000",
        lines: [],
        exit: { code: 0 },
      }),
      makeEnv(db, sr.runner),
      makeExecCtx(),
    );
    expect(sr.get).toHaveBeenCalledWith("session-1:r1700000000000");
  });

  it("still 200s when the workflow instance is gone", async () => {
    const db = new FakeD1();
    seedSession(db);
    const get = vi.fn(async () => {
      throw new Error("instance not found");
    });
    const res = await buildApp().fetch(
      await ingestRequest("session-1", {
        instance_id: "session-1",
        lines: [],
        exit: { code: 0 },
      }),
      makeEnv(db, { get, create: vi.fn() }),
      makeExecCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ terminal: true, woke: false });
  });
});
