import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { Env } from "../src/index";
import { SessionRunner } from "../src/workflows/session-runner";
import type { AgentSessionEventWebhook } from "../src/types/agent-session";

/**
 * Tests the SessionRunner workflow class directly with a hand-rolled
 * `step` stub that just runs the supplied function inline. We can't run
 * the real Workflows runtime under vitest without `@cloudflare/vitest-
 * pool-workers`, so we verify the orchestration logic — what each step
 * returns and how the next branch reads it — and rely on `wrangler dev`
 * + a real Linear delivery for the durable runtime path. Each test ends
 * by asserting the sequence of activity posts captured via a fetch spy.
 */

const linearCalls: Array<{
  agentSessionId: string;
  content: { type: string; body?: string; action?: string };
}> = [];

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
    SESSION_RUNNER: {} as Workflow,
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
    LINEAR_WEBHOOK_SECRET: "linear-secret",
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

/**
 * Build a `step` stub matching `WorkflowStep` closely enough for our
 * use. `step.do(name, opts?, fn)` runs the function inline and tracks
 * the sequence of step names that ran so tests can assert on the
 * orchestration shape (e.g., that `dispatch-run` was reached or that we
 * short-circuited at `post-no-repo-error`).
 */
function makeStep() {
  const ran: string[] = [];
  const step = {
    async do(
      name: string,
      optsOrFn: unknown,
      maybeFn?: unknown,
    ): Promise<unknown> {
      ran.push(name);
      const fn =
        typeof optsOrFn === "function"
          ? (optsOrFn as () => unknown | Promise<unknown>)
          : (maybeFn as () => unknown | Promise<unknown>);
      return await fn();
    },
    async sleep(_name: string, _duration: string) {
      return;
    },
    async sleepUntil(_name: string, _timestamp: Date | number) {
      return;
    },
    async waitForEvent() {
      throw new Error("waitForEvent not stubbed");
    },
  };
  return { step, ran };
}

/**
 * Stub `WorkflowEvent<SessionRunnerParams>` shape — only `payload` is
 * read by SessionRunner.run.
 */
function makeEvent(webhookEvent: AgentSessionEventWebhook) {
  return {
    payload: { event: webhookEvent },
    timestamp: new Date(),
    instanceId: webhookEvent.agentSession.id,
  };
}

/**
 * Same fetch-spy shape as `webhook.test.ts` so the assertions stay
 * aligned across the legacy `runSession` path and the workflow path.
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
          variables?: {
            input?: {
              agentSessionId: string;
              content: { type: string; body?: string; action?: string };
            };
          };
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

beforeEach(() => {
  linearCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Instantiate SessionRunner without going through `WorkflowEntrypoint`'s
 * normal constructor (which expects a Cloudflare-internal `ctx`). We
 * `Object.create` the prototype, then assign `env` directly — this is
 * the same pattern the Plan agent recommended for unit-testing
 * Workflows under plain vitest.
 */
function buildRunner(env: Env): SessionRunner {
  const runner = Object.create(SessionRunner.prototype) as SessionRunner;
  Object.assign(runner, { env, ctx: {} });
  return runner;
}

const baseSession = {
  id: "session-1",
  issue: {
    id: "issue-1",
    identifier: "SYM-1",
    title: "Add date to README",
    teamId: "team-abc",
  },
  promptContext: "Please add today's date.",
};

describe("SessionRunner.run — happy path", () => {
  it("posts thought + response and runs all 5 steps", async () => {
    const kv = new FakeKV();
    await kv.put("access_token", "fake-token");
    installFetchMock({
      body: {
        engine: "pi",
        exit_code: 0,
        stdout:
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done — opened PR #123."}]}}',
        stderr: "",
        duration_ms: 4567,
      },
    });

    const env = makeEnv(kv);
    const runner = buildRunner(env);
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-1",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);

    expect(result).toEqual({ status: "ok", exit_code: 0 });
    expect(ran).toEqual([
      "load-token",
      "post-initial-thought",
      "resolve-inputs",
      "dispatch-run",
      "post-terminal-activity",
    ]);
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "response",
    ]);
    expect(linearCalls[1]?.content.body).toBe("Done — opened PR #123.");
  });
});

describe("SessionRunner.run — abort branches", () => {
  it("returns no_token without posting when access_token is missing", async () => {
    const kv = new FakeKV();
    // No access_token put.
    const runner = buildRunner(makeEnv(kv));
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-2",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({ status: "no_token" });
    expect(ran).toEqual(["load-token"]);
    expect(linearCalls).toHaveLength(0);
  });

  it("posts thought + error when no repo is configured for the team", async () => {
    const kv = new FakeKV();
    await kv.put("access_token", "fake-token");
    installFetchMock({ body: { error: "should-not-be-called" } });
    const env = makeEnv(kv, { PROJECT_MAPPINGS_JSON: "{}" });
    const runner = buildRunner(env);
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-3",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({ status: "no_repo" });
    expect(ran).toEqual([
      "load-token",
      "post-initial-thought",
      "resolve-inputs",
      "post-no-repo-error",
    ]);
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "error",
    ]);
    expect(linearCalls[1]?.content.body).toContain("No repository is configured");
  });

  it("posts thought + error when no prompt is in the payload", async () => {
    const kv = new FakeKV();
    await kv.put("access_token", "fake-token");
    installFetchMock({ body: {} });
    const runner = buildRunner(makeEnv(kv));
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-4",
      agentSession: { id: "session-1", issue: { ...baseSession.issue, title: "" } },
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({ status: "no_prompt" });
    expect(ran).toEqual([
      "load-token",
      "post-initial-thought",
      "resolve-inputs",
      "post-no-prompt-error",
    ]);
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "error",
    ]);
    expect(linearCalls[1]?.content.body).toContain("Couldn't find a prompt");
  });
});

describe("SessionRunner.run — dispatch failures", () => {
  it("posts thought + error when the dispatcher returns 412", async () => {
    const kv = new FakeKV();
    await kv.put("access_token", "fake-token");
    installFetchMock({
      status: 412,
      body: { error: "missing_auth_backup", scope: "default" },
    });
    const runner = buildRunner(makeEnv(kv));
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-5",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({ status: "error", exit_code: null });
    expect(ran).toEqual([
      "load-token",
      "post-initial-thought",
      "resolve-inputs",
      "dispatch-run",
      "post-terminal-activity",
    ]);
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "error",
    ]);
    expect(linearCalls[1]?.content.body).toContain("Dispatcher error (412)");
    expect(linearCalls[1]?.content.body).toContain("missing_auth_backup");
  });

  it("posts thought + error when the engine exits non-zero", async () => {
    const kv = new FakeKV();
    await kv.put("access_token", "fake-token");
    installFetchMock({
      body: {
        engine: "pi",
        exit_code: 2,
        stdout: "",
        stderr: "ENOENT: codex auth missing",
        duration_ms: 100,
      },
    });
    const runner = buildRunner(makeEnv(kv));
    const { step } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      action: "created",
      webhookId: "wh-6",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({ status: "ok", exit_code: 2 });
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "error",
    ]);
    expect(linearCalls[1]?.content.body).toContain("Engine exited with code 2");
    expect(linearCalls[1]?.content.body).toContain("ENOENT");
  });
});
