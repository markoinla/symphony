import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { Env } from "../src/index";
import { SessionRunner } from "../src/workflows/session-runner";
import type { AgentSessionEventWebhook } from "../src/types/agent-session";
import type {
  NormalizedEvent,
  RunTerminalPayload,
} from "../src/lib/dispatcher";
import { FakeD1 } from "./helpers/fake-d1";

/**
 * Tests the SessionRunner workflow class directly with a hand-rolled
 * `step` stub that runs the supplied function inline. We can't run the
 * real Workflows runtime under vitest without `@cloudflare/vitest-
 * pool-workers`, so we verify the orchestration: what each step
 * returns, how the multi-turn loop branches, and what shows up in
 * Linear. Real durable execution is verified via `wrangler dev` + a
 * live Linear delivery.
 *
 * The dispatcher is mocked at the fetch layer with an SSE response
 * built from a NormalizedEvent script. This matches the real wire
 * format (item 2 — see workers/sandbox-dispatcher/src/run.ts).
 */

const linearCalls: Array<{
  agentSessionId: string;
  content: {
    type: string;
    body?: string;
    action?: string;
    parameter?: string;
    result?: string;
  };
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

// Tests use a fixed Better Auth org id `org-1`, mapped to the
// Linear org `linear-org-1`. The load-token step looks up the install
// by linear_organization_id; subsequent steps key off the Better Auth
// organization_id.
const NOW_SEC = () => Math.floor(Date.now() / 1000);
const LINEAR_ORG_ID = "linear-org-1";
const ORG_ID = "org-1";

function makeSeededDb(): FakeD1 {
  const db = new FakeD1();
  db.projects.set(`${ORG_ID}:team-abc`, {
    id: "project-uuid-1",
    organization_id: ORG_ID,
    linear_team_id: "team-abc",
    linear_team_name: "",
    repo_url: "https://github.com/markoinla/symphony.git",
    default_branch: "main",
    engine: "pi",
    model: null,
    max_turns: 10,
    scope: null,
    system_prompt_override: null,
    created_at: NOW_SEC(),
    updated_at: NOW_SEC(),
  });
  return db;
}

function makeEnv(
  kv: FakeKV,
  overrides: Partial<Env> = {},
  db: FakeD1 = makeSeededDb(),
): Env {
  return {
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    LINEAR_TOKENS: kv as unknown as KVNamespace,
    SESSION_RUNNER: {} as Workflow,
    DB: db as unknown as D1Database,
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
    LINEAR_WEBHOOK_SECRET: "linear-secret",
    DISPATCHER_URL: "https://dispatcher.example",
    DISPATCH_HMAC_SECRET: HMAC_SECRET,
    URL: "https://agent.example",
    DEFAULT_SCOPE: "default",
    DEFAULT_MODEL: "anthropic/claude-sonnet-4-6",
    DEFAULT_ENGINE: "pi",
    DEFAULT_MAX_TURNS: "10",
    ...overrides,
  };
}

/**
 * Hand-rolled `step` stub. `do` runs the callback inline; `waitForEvent`
 * resolves the engine-push events the runner parks on:
 *   - `run-terminal-N` → the `run.terminal` payload (`opts.terminal`),
 *     or rejects when `opts.terminalTimeout` is set.
 *   - `wait-for-prompted-N` → `opts.followup`, or rejects (no follow-up).
 */
function makeStep(
  opts: {
    terminal?: RunTerminalPayload;
    terminalTimeout?: boolean;
    followup?: AgentSessionEventWebhook;
  } = {},
) {
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
    async waitForEvent(
      name: string,
      _options: { type: string; timeout?: string | number },
    ) {
      if (name.startsWith("run-terminal-")) {
        if (opts.terminalTimeout) {
          throw new Error("waitForEvent timed out");
        }
        return {
          payload: opts.terminal ?? {
            exit_code: 0,
            error: null,
            last_assistant: null,
          },
          timestamp: new Date(),
          type: "run.terminal",
        };
      }
      if (name.startsWith("wait-for-prompted-")) {
        if (opts.followup) {
          return {
            payload: opts.followup,
            timestamp: new Date(),
            type: "linear.prompted",
          };
        }
        throw new Error("waitForEvent timed out");
      }
      throw new Error(`waitForEvent not stubbed: ${name}`);
    },
  };
  return { step, ran };
}

function makeEvent(
  arg:
    | AgentSessionEventWebhook
    | {
        mode?: "agent_session";
        event: AgentSessionEventWebhook;
        workflow_overrides?: {
          engine?: string;
          model?: string;
          max_turns?: number;
          allowed_tools?: string[];
          disallowed_tools?: string[];
          permission_mode?: string;
        };
      },
) {
  // Accept either a bare webhookEvent (legacy shorthand) or a full
  // params object so resolution-chain tests can pass workflow_overrides.
  const params =
    "agentSession" in arg ? { event: arg } : arg;
  return {
    payload: params,
    timestamp: new Date(),
    instanceId: params.event.agentSession.id,
  };
}

/**
 * Build an SSE-formatted body from a NormalizedEvent script. Each
 * event becomes one `data: <json>\n\n` frame. Matches the wire
 * format the real dispatcher emits.
 */
function buildSseBody(events: NormalizedEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/**
 * Build an SSE-formatted body where each char in the joined frames is
 * read in tiny chunks. Used to verify the SessionRunner's parser
 * handles partial-line streaming.
 */
function buildSseBodyStream(
  events: NormalizedEvent[],
): ReadableStream<Uint8Array> {
  const body = buildSseBody(events);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

/**
 * Fetch mock that routes Linear GraphQL to a canned success and
 * dispatcher `/run` to an SSE body built from `dispatcherEvents`.
 *
 * `failDispatcher` lets a test simulate a connection-level failure
 * (non-2xx response) which DispatcherClient turns into a thrown
 * DispatcherError.
 */
function installFetchMock(opts: {
  dispatcherEvents?: NormalizedEvent[];
  dispatcherStatus?: number;
  dispatcherErrorBody?: unknown;
  // `/run/start` (engine-push) response control. `startStatus` !== 200
  // returns `startErrorBody` so DispatcherClient.start throws.
  startStatus?: number;
  startErrorBody?: unknown;
  // When provided, every dispatcher call is recorded here so tests can
  // assert which endpoint the turn hit.
  dispatcherCalls?: Array<{ url: string; body: string }>;
}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = init?.body as string | undefined;

    if (url === "https://api.linear.app/graphql") {
      return new Response(routeLinearGraphql(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/run/start")) {
      opts.dispatcherCalls?.push({ url, body: body ?? "" });
      if (opts.startStatus && opts.startStatus !== 200) {
        return new Response(JSON.stringify(opts.startErrorBody ?? {}), {
          status: opts.startStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ ok: true, run_id: "session-1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/run") || url.endsWith("/run/attach")) {
      opts.dispatcherCalls?.push({ url, body: body ?? "" });
      if (opts.dispatcherStatus && opts.dispatcherStatus !== 200) {
        return new Response(JSON.stringify(opts.dispatcherErrorBody ?? {}), {
          status: opts.dispatcherStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(buildSseBodyStream(opts.dispatcherEvents ?? []), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

interface ParsedLinearBody {
  query?: string;
  variables?: {
    input?: {
      agentSessionId?: string;
      content?: {
        type: string;
        body?: string;
        action?: string;
        parameter?: string;
        result?: string;
      };
    };
  };
}

/**
 * Dispatch a Linear GraphQL POST body to the appropriate canned
 * response. T3 added several non-activity mutations (workflowStates
 * query, issueUpdate, agentSessionUpdate, viewer query); all are
 * answered with success and only `agentActivityCreate` calls get
 * pushed into `linearCalls` so the existing assertions about timeline
 * activities keep working.
 */
function routeLinearGraphql(body: string | undefined): string {
  if (!body) {
    return JSON.stringify({
      data: { agentActivityCreate: { success: true } },
    });
  }
  let parsed: ParsedLinearBody;
  try {
    parsed = JSON.parse(body) as ParsedLinearBody;
  } catch {
    return JSON.stringify({});
  }
  const query = parsed.query ?? "";

  if (query.includes("AgentActivityCreate")) {
    const input = parsed.variables?.input;
    if (input && input.agentSessionId && input.content) {
      linearCalls.push({
        agentSessionId: input.agentSessionId,
        content: input.content,
      });
    }
    return JSON.stringify({ data: { agentActivityCreate: { success: true } } });
  }
  if (query.includes("WorkflowStates")) {
    return JSON.stringify({
      data: {
        workflowStates: {
          nodes: [{ id: "started-1", name: "In Progress", position: 1, type: "started" }],
        },
      },
    });
  }
  if (query.includes("IssueUpdate")) {
    return JSON.stringify({ data: { issueUpdate: { success: true } } });
  }
  if (query.includes("AgentSessionUpdate")) {
    return JSON.stringify({
      data: { agentSessionUpdate: { success: true } },
    });
  }
  if (query.includes("viewer")) {
    return JSON.stringify({ data: { viewer: { id: "agent-viewer-1" } } });
  }
  return JSON.stringify({ data: {} });
}

beforeEach(() => {
  linearCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildRunner(env: Env): SessionRunner {
  const runner = Object.create(SessionRunner.prototype) as SessionRunner;
  Object.assign(runner, { env, ctx: {} });
  return runner;
}

function seededDb(): FakeD1 {
  const db = new FakeD1();
  db.linearAgentInstalls.set(ORG_ID, {
    id: "install-uuid-1",
    organization_id: ORG_ID,
    linear_organization_id: LINEAR_ORG_ID,
    access_token: "fake-token",
    refresh_token: null,
    scopes: "read,write",
    installed_by_user_id: "user-1",
    status: "active",
    installed_at: NOW_SEC(),
    refreshed_at: NOW_SEC(),
    expires_at: null,
  });
  db.projects.set(`${ORG_ID}:team-abc`, {
    id: "project-uuid-1",
    organization_id: ORG_ID,
    linear_team_id: "team-abc",
    linear_team_name: "",
    repo_url: "https://github.com/markoinla/symphony.git",
    default_branch: "main",
    engine: "pi",
    model: null,
    max_turns: 10,
    scope: null,
    system_prompt_override: null,
    created_at: NOW_SEC(),
    updated_at: NOW_SEC(),
  });
  return db;
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
  it("starts the run and posts thought + response from the run.terminal event", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    const dispatcherCalls: Array<{ url: string; body: string }> = [];
    installFetchMock({ dispatcherCalls });

    const env = makeEnv(kv, {}, db);
    const runner = buildRunner(env);
    // pi pushes its events to the ingest endpoint; the workflow parks
    // until the `run.terminal` event carries the outcome.
    const { step, ran } = makeStep({
      terminal: {
        exit_code: 0,
        error: null,
        last_assistant: "Done — opened PR #123.",
      },
    });

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-1",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);

    expect(result).toEqual({
      status: "ok",
      exit_code: 0,
      turns: 1,
      pr_url: null,
    });
    expect(ran).toEqual([
      "load-token",
      "post-initial-thought",
      "start-session-side-effects",
      "resolve-inputs",
      "mint-github-token",
      "record-session-start",
      "resolve-linear-mcp-token-1",
      "start-run-1",
      "post-terminal-activity",
      "update-final-plan",
      "record-session-end",
      "stop-sandbox",
    ]);
    // The dispatcher was hit at the fire-and-forget /run/start, never
    // the streaming /run.
    expect(dispatcherCalls).toHaveLength(1);
    expect(dispatcherCalls[0]!.url).toMatch(/\/run\/start$/);
    // The workflow posts only the initial thought + terminal response;
    // per-event timeline activities are the ingest endpoint's job now.
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "response",
    ]);
    expect(linearCalls[1]?.content.body).toBe("Done — opened PR #123.");
  });
});

describe("SessionRunner.run — abort branches", () => {
  it("returns no_token without posting when no installation exists", async () => {
    const kv = new FakeKV();
    const runner = buildRunner(makeEnv(kv));
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-2",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({ status: "no_token" });
    // `stop-sandbox` always runs from the outer try/finally even on
    // early-return paths.
    expect(ran).toEqual(["load-token", "stop-sandbox"]);
    expect(linearCalls).toHaveLength(0);
  });

  it("posts thought + error when no repo is configured for the team", async () => {
    const kv = new FakeKV();
    installFetchMock({ dispatcherEvents: [] });
    const installOnlyDb = new FakeD1();
    installOnlyDb.linearAgentInstalls.set(ORG_ID, {
      id: "install-uuid-1",
      organization_id: ORG_ID,
      linear_organization_id: LINEAR_ORG_ID,
      access_token: "fake-token",
      refresh_token: null,
      scopes: "read,write",
      installed_by_user_id: "user-1",
      status: "active",
      installed_at: NOW_SEC(),
      refreshed_at: NOW_SEC(),
      expires_at: null,
    });
    const env = makeEnv(kv, {}, installOnlyDb);
    const runner = buildRunner(env);
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
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
      "start-session-side-effects",
      "resolve-inputs",
      "post-no-repo-error",
      "stop-sandbox",
    ]);
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "elicitation",
    ]);
    expect(linearCalls[1]?.content.body).toContain(
      "No repository is configured for this team yet",
    );
  });

  it("posts thought + error when no prompt is in the payload", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({ dispatcherEvents: [] });
    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-4",
      agentSession: { id: "session-1", issue: { ...baseSession.issue, title: "" } },
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({ status: "no_prompt" });
    expect(ran).toEqual([
      "load-token",
      "post-initial-thought",
      "start-session-side-effects",
      "resolve-inputs",
      "post-no-prompt-error",
      "stop-sandbox",
    ]);
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "elicitation",
    ]);
    expect(linearCalls[1]?.content.body).toContain(
      "I didn't find a prompt in this session",
    );
  });
});

describe("SessionRunner.run — dispatch failures", () => {
  it("posts thought + error when /run/start returns a non-2xx response", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({
      startStatus: 412,
      startErrorBody: { error: "missing_baseline", engine: "pi" },
    });

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-5",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({
      status: "error",
      exit_code: null,
      turns: 1,
      pr_url: null,
    });
    expect(ran).toEqual([
      "load-token",
      "post-initial-thought",
      "start-session-side-effects",
      "resolve-inputs",
      "mint-github-token",
      "record-session-start",
      "resolve-linear-mcp-token-1",
      "start-run-1",
      "post-terminal-activity",
      "update-final-plan",
      "record-session-end",
      "stop-sandbox",
    ]);
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "error",
    ]);
    expect(linearCalls[1]?.content.body).toContain("412");
    expect(linearCalls[1]?.content.body).toContain("missing_baseline");
  });

  it("posts thought + error when the run.terminal event reports a non-zero exit", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({});

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step } = makeStep({
      terminal: {
        exit_code: 2,
        error: "ENOENT: pi auth missing",
        last_assistant: null,
      },
    });

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-6",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({
      status: "ok",
      exit_code: 2,
      turns: 1,
      pr_url: null,
    });
    // The workflow posts the initial thought + a terminal error built
    // from the run.terminal payload. Live per-event error activities
    // are posted by the ingest endpoint, not here.
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "error",
    ]);
    expect(linearCalls[1]?.content.body).toContain("Engine exited with code 2");
    expect(linearCalls[1]?.content.body).toContain("ENOENT");
  });

  it("posts thought + error when the run never reports a terminal event", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({});

    const runner = buildRunner(makeEnv(kv, {}, db));
    // The forwarder never POSTs a terminal batch — runPushTurn's
    // waitForEvent times out.
    const { step } = makeStep({ terminalTimeout: true });

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-7",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({
      status: "error",
      exit_code: null,
      turns: 1,
      pr_url: null,
    });
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "error",
    ]);
    expect(linearCalls[1]?.content.body).toContain("run_terminal_timeout");
  });
});


// The engine-driven `needs_continuation` multi-turn tests were removed
// in SYM-386: pi runs its whole agentic loop in one invocation and
// never reports `needs_continuation`, so for pi a session is exactly
// one turn. The `linear.prompted` follow-up loop is exercised by the
// happy-path tests (each ends by parking on `wait-for-prompted-1`).

// Resolution chain assertions: workflow_overrides > settings > env.
// We capture the dispatcher `/run` request body to read which model
// the runner picked.
describe("SessionRunner.run — model resolution", () => {
  it("uses env.DEFAULT_MODEL when no settings row and no overrides", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    const capturedBodies: Record<string, unknown>[] = [];
    captureDispatcherRunBodies(capturedBodies);

    const env = makeEnv(kv, {}, db);
    const runner = buildRunner(env);
    const { step } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-resolution-env",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    await runner.run(makeEvent(event), step as never);
    expect(capturedBodies[0]?.model).toBe(env.DEFAULT_MODEL);
  });

  it("prefers settings('agent.default_model') over env", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    db.settings.set(`${ORG_ID}:agent.default_model`, {
      id: "s-model",
      organization_id: ORG_ID,
      key: "agent.default_model",
      value: "anthropic/claude-haiku-from-settings",
      created_at: NOW_SEC(),
      updated_at: NOW_SEC(),
    });
    const capturedBodies: Record<string, unknown>[] = [];
    captureDispatcherRunBodies(capturedBodies);

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-resolution-settings",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    await runner.run(makeEvent(event), step as never);
    expect(capturedBodies[0]?.model).toBe("anthropic/claude-haiku-from-settings");
  });

  it("prefers workflow_overrides.model over settings and env", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    db.settings.set(`${ORG_ID}:agent.default_model`, {
      id: "s-model",
      organization_id: ORG_ID,
      key: "agent.default_model",
      value: "anthropic/claude-haiku-from-settings",
      created_at: NOW_SEC(),
      updated_at: NOW_SEC(),
    });
    const capturedBodies: Record<string, unknown>[] = [];
    captureDispatcherRunBodies(capturedBodies);

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-resolution-workflow",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    await runner.run(
      makeEvent({
        mode: "agent_session",
        event,
        workflow_overrides: { model: "workflow-explicit-model" },
      }),
      step as never,
    );
    expect(capturedBodies[0]?.model).toBe("workflow-explicit-model");
  });

  it("passes workflow policy overrides through to the dispatcher request", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    const capturedBodies: Record<string, unknown>[] = [];
    captureDispatcherRunBodies(capturedBodies);

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-resolution-policy",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    await runner.run(
      makeEvent({
        mode: "agent_session",
        event,
        workflow_overrides: {
          allowed_tools: ["Read", "Bash"],
          disallowed_tools: ["WebFetch"],
          permission_mode: "ask",
        },
      }),
      step as never,
    );

    expect(capturedBodies[0]?.allowed_tools).toEqual(["Read", "Bash"]);
    expect(capturedBodies[0]?.disallowed_tools).toEqual(["WebFetch"]);
    expect(capturedBodies[0]?.permission_mode).toBe("ask");
  });
});

// Capture dispatcher `/run` POST bodies for resolution-chain
// assertions. Mirrors installFetchMock but pushes the parsed body
// into the provided sink instead of just returning canned events.
// The SSE re-attach test was removed in SYM-386: pi no longer streams
// over SSE, so there is no cursor to re-attach from. Workflow eviction
// during an engine-push run is handled by the step journal — on resume
// `start-run-N` replays and `run-terminal-N` re-enters its wait.

function captureDispatcherRunBodies(
  sink: Record<string, unknown>[],
): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = init?.body as string | undefined;

    if (url === "https://api.linear.app/graphql") {
      return new Response(routeLinearGraphql(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/run/start")) {
      if (body) {
        try {
          sink.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          // ignore — body parse failure surfaces via the assertion
        }
      }
      return new Response(
        JSON.stringify({ ok: true, run_id: "session-1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

// Tests for T3's start-session-side-effects step: status transition,
// delegate assignment, dashboard externalUrls, and initial plan
// posting. Captures every Linear GraphQL POST so we can verify which
// mutations fired with which variables — rather than relying on the
// stripped-down `linearCalls` array that only records
// `agentActivityCreate`.
interface CapturedMutation {
  operation: string;
  variables: Record<string, unknown>;
}

function installFetchMockCapturing(opts: {
  dispatcherEvents?: NormalizedEvent[];
  publicUrl?: string;
  startedStateId?: string | null;
  viewerId?: string | null;
}): CapturedMutation[] {
  const captured: CapturedMutation[] = [];
  const startedStateId =
    opts.startedStateId === undefined ? "started-1" : opts.startedStateId;
  const viewerId = opts.viewerId === undefined ? "agent-viewer-1" : opts.viewerId;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = init?.body as string | undefined;

    if (url === "https://api.linear.app/graphql") {
      if (body) {
        const parsed = JSON.parse(body) as {
          query?: string;
          variables?: Record<string, unknown>;
        };
        const query = parsed.query ?? "";
        let operation = "unknown";
        if (query.includes("AgentActivityCreate")) operation = "agentActivityCreate";
        else if (query.includes("WorkflowStates")) operation = "workflowStates";
        else if (query.includes("IssueUpdate")) operation = "issueUpdate";
        else if (query.includes("AgentSessionUpdate")) operation = "agentSessionUpdate";
        else if (query.includes("viewer")) operation = "viewer";
        captured.push({ operation, variables: parsed.variables ?? {} });

        if (operation === "agentActivityCreate") {
          const input = (parsed.variables?.input ?? {}) as {
            agentSessionId?: string;
            content?: {
              type: string;
              body?: string;
              action?: string;
              parameter?: string;
              result?: string;
            };
          };
          if (input.agentSessionId && input.content) {
            linearCalls.push({
              agentSessionId: input.agentSessionId,
              content: input.content,
            });
          }
        }
      }

      // Canned responses per operation.
      const parsed = JSON.parse(body ?? "{}") as { query?: string };
      const q = parsed.query ?? "";
      if (q.includes("WorkflowStates")) {
        return new Response(
          JSON.stringify({
            data: {
              workflowStates: {
                nodes: startedStateId
                  ? [
                      {
                        id: startedStateId,
                        name: "In Progress",
                        position: 1,
                        type: "started",
                      },
                    ]
                  : [],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("viewer")) {
        return new Response(
          JSON.stringify({
            data: { viewer: viewerId ? { id: viewerId } : null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("IssueUpdate")) {
        return new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (q.includes("AgentSessionUpdate")) {
        return new Response(
          JSON.stringify({
            data: { agentSessionUpdate: { success: true } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: { agentActivityCreate: { success: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/run/start")) {
      return new Response(
        JSON.stringify({ ok: true, run_id: "session-1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/run")) {
      return new Response(
        buildSseBodyStream(
          opts.dispatcherEvents ?? [
            { type: "assistant_msg", text: "ok" },
            { type: "turn_end", turn: 1, reason: "completed" },
            {
              type: "result",
              exit_code: 0,
              duration_ms: 1,
              branch: null,
              pr_url: null,
            },
          ],
        ),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }

    throw new Error(`unexpected fetch in test: ${url}`);
  });

  return captured;
}

describe("SessionRunner.run — start-session-side-effects", () => {
  it("on `created`: queries viewer, then issueUpdate (delegate only) + agentSessionUpdate (externalUrls + plan)", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    const captured = installFetchMockCapturing({});

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-side-effects",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    await runner.run(makeEvent(event), step as never);

    expect(ran).toContain("start-session-side-effects");
    expect(ran).toContain("update-final-plan");

    // Status transitions are owned by the workflow prompt now — the
    // session runner must NOT fetch the team's started state.
    expect(captured.find((c) => c.operation === "workflowStates")).toBeUndefined();

    // Viewer id was fetched (no cached entry on the cold KV).
    expect(captured.some((c) => c.operation === "viewer")).toBe(true);

    // issueUpdate: delegateId only — no stateId.
    const issueUpdate = captured.find((c) => c.operation === "issueUpdate");
    expect(issueUpdate).toBeDefined();
    expect(issueUpdate!.variables).toMatchObject({
      id: "issue-1",
      input: { delegateId: "agent-viewer-1" },
    });
    expect(
      (issueUpdate!.variables.input as { stateId?: string }).stateId,
    ).toBeUndefined();

    // agentSessionUpdate must fire at least twice: once with the
    // externalUrls and once with the initial plan (start-side-effects).
    // A third call with the final plan happens after the terminal step.
    const sessionUpdates = captured.filter(
      (c) => c.operation === "agentSessionUpdate",
    );
    expect(sessionUpdates.length).toBeGreaterThanOrEqual(2);

    // Externally-linkable URL points to the dashboard for this session.
    const extCall = sessionUpdates.find(
      (c) =>
        (c.variables.input as { externalUrls?: unknown[] })?.externalUrls !==
        undefined,
    );
    expect(extCall).toBeDefined();
    expect(extCall!.variables).toMatchObject({
      id: "session-1",
      input: {
        externalUrls: [
          {
            label: "Open in Symphony",
            url: "https://agent.example/dashboard/sessions/session-1",
          },
        ],
      },
    });

    // Initial plan: two items, second still in progress at start.
    const planInitCall = sessionUpdates.find((c) => {
      const plan = (c.variables.input as { plan?: Array<{ status: string }> })
        ?.plan;
      return (
        Array.isArray(plan) &&
        plan.length === 2 &&
        plan[1]?.status === "inProgress"
      );
    });
    expect(planInitCall).toBeDefined();

    // Final plan: both items completed (engine exit_code 0).
    const planFinalCall = sessionUpdates.find((c) => {
      const plan = (c.variables.input as { plan?: Array<{ status: string }> })
        ?.plan;
      return (
        Array.isArray(plan) &&
        plan.length === 2 &&
        plan[1]?.status === "completed"
      );
    });
    expect(planFinalCall).toBeDefined();
  });

  it("on `prompted`: skips start-session-side-effects entirely (status/delegate untouched)", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    const captured = installFetchMockCapturing({});

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "prompted",
      webhookId: "wh-prompted",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    await runner.run(makeEvent(event), step as never);

    expect(ran).not.toContain("start-session-side-effects");
    expect(ran).not.toContain("update-final-plan");
    expect(captured.find((c) => c.operation === "issueUpdate")).toBeUndefined();
    expect(
      captured.find((c) => c.operation === "agentSessionUpdate"),
    ).toBeUndefined();
    expect(captured.find((c) => c.operation === "workflowStates")).toBeUndefined();
    expect(captured.find((c) => c.operation === "viewer")).toBeUndefined();
  });

  it("skips externalUrls when env.URL is unset and continues running", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    const captured = installFetchMockCapturing({});

    // Empty string disables the externalUrls call.
    const env = makeEnv(kv, { URL: "" }, db);
    const runner = buildRunner(env);
    const { step } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-no-url",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    await runner.run(makeEvent(event), step as never);

    // No agentSessionUpdate call with externalUrls — but plan calls
    // still happen.
    const externalCall = captured.find(
      (c) =>
        c.operation === "agentSessionUpdate" &&
        (c.variables.input as { externalUrls?: unknown })?.externalUrls !==
          undefined,
    );
    expect(externalCall).toBeUndefined();

    // Plan was still posted (init + final).
    const planCalls = captured.filter(
      (c) =>
        c.operation === "agentSessionUpdate" &&
        (c.variables.input as { plan?: unknown })?.plan !== undefined,
    );
    expect(planCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("caches viewer id in KV across runs (second run skips the viewer query)", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    const captured = installFetchMockCapturing({});

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step } = makeStep();

    const event1: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-cache-1",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };
    const event2: AgentSessionEventWebhook = {
      ...event1,
      webhookId: "wh-cache-2",
    };

    await runner.run(makeEvent(event1), step as never);
    const firstViewerCalls = captured.filter((c) => c.operation === "viewer");

    await runner.run(makeEvent(event2), step as never);
    const totalViewerCalls = captured.filter((c) => c.operation === "viewer");

    // First run fetches the viewer; second uses the KV cache and skips.
    expect(firstViewerCalls.length).toBe(1);
    expect(totalViewerCalls.length).toBe(1);
    // KV has the cached entry.
    expect(await kv.get(`viewer:${LINEAR_ORG_ID}`)).toBe("agent-viewer-1");
  });

});
