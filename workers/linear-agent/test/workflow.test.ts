import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { Env } from "../src/index";
import { SessionRunner } from "../src/workflows/session-runner";
import type { AgentSessionEventWebhook } from "../src/types/agent-session";
import type { NormalizedEvent } from "../src/lib/dispatcher";
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

function makeEvent(webhookEvent: AgentSessionEventWebhook) {
  return {
    payload: { event: webhookEvent },
    timestamp: new Date(),
    instanceId: webhookEvent.agentSession.id,
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
              content: {
                type: string;
                body?: string;
                action?: string;
                parameter?: string;
                result?: string;
              };
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
  it("streams assistant_msg and posts thought + response with the last assistant text", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({
      dispatcherEvents: [
        { type: "assistant_msg", text: "Looking at this." },
        { type: "assistant_msg", text: "Done — opened PR #123." },
        { type: "turn_end", turn: 1, reason: "completed" },
        {
          type: "result",
          exit_code: 0,
          duration_ms: 4567,
          branch: null,
          pr_url: null,
        },
      ],
    });

    const env = makeEnv(kv, {}, db);
    const runner = buildRunner(env);
    const { step, ran } = makeStep();

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
      "resolve-inputs",
      "transition-to-in-progress",
      "mint-github-token",
      "record-session-start",
      "resolve-linear-mcp-token-1",
      "turn-1",
      "post-terminal-activity",
      "record-session-end",
    ]);
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "response",
    ]);
    expect(linearCalls[1]?.content.body).toBe("Done — opened PR #123.");
  });

  it("posts tool_call as an action activity in the timeline", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({
      dispatcherEvents: [
        {
          type: "tool_call",
          tool: "read_file",
          args: { path: "README.md" },
          tool_id: "call_1",
        },
        { type: "assistant_msg", text: "All done." },
        { type: "turn_end", turn: 1, reason: "completed" },
        {
          type: "result",
          exit_code: 0,
          duration_ms: 1000,
          branch: null,
          pr_url: null,
        },
      ],
    });

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-tool",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    await runner.run(makeEvent(event), step as never);

    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "action",
      "response",
    ]);
    expect(linearCalls[1]?.content).toMatchObject({
      type: "action",
      action: "read_file",
    });
    expect(linearCalls[1]?.content.parameter).toContain("README.md");
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
    expect(ran).toEqual(["load-token"]);
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
  it("posts thought + error when the dispatcher returns a non-2xx response", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({
      dispatcherStatus: 412,
      dispatcherErrorBody: {
        error: "missing_auth_backup",
        scope: "default",
      },
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
      "resolve-inputs",
      "transition-to-in-progress",
      "mint-github-token",
      "record-session-start",
      "resolve-linear-mcp-token-1",
      "turn-1",
      "post-terminal-activity",
      "record-session-end",
    ]);
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "error",
    ]);
    expect(linearCalls[1]?.content.body).toContain("Dispatcher error (412)");
    expect(linearCalls[1]?.content.body).toContain("missing_auth_backup");
  });

  it("posts thought + error when the engine result frame has non-zero exit", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({
      dispatcherEvents: [
        { type: "error", message: "ENOENT: codex auth missing" },
        { type: "turn_end", turn: 1, reason: "completed" },
        {
          type: "result",
          exit_code: 2,
          duration_ms: 100,
          branch: null,
          pr_url: null,
        },
      ],
    });

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step } = makeStep();

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
    // SSE in-band error becomes a live `error` activity in the timeline
    // AND drives the terminal error post.
    expect(linearCalls.map((c) => c.content.type)).toEqual([
      "thought",
      "error",
      "error",
    ]);
    expect(linearCalls[2]?.content.body).toContain("Engine exited with code 2");
    expect(linearCalls[2]?.content.body).toContain("ENOENT");
  });

  it("posts thought + error when the stream closes without a result frame", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({
      // Stream closes after the assistant_msg without a turn_end / result.
      dispatcherEvents: [
        { type: "assistant_msg", text: "interrupted" },
      ],
    });

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step } = makeStep();

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
    expect(linearCalls[1]?.content.body).toContain(
      "stream_closed_without_result_frame",
    );
  });
});

describe("SessionRunner.run — PR creation (item 4)", () => {
  it("creates a PR, adds the symphony label, attaches it to Linear, and appends the URL to the response", async () => {
    const kv = new FakeKV();
    const db = seededDb();

    const githubCalls: Array<{ url: string; body?: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = init?.body as string | undefined;

      if (url === "https://api.linear.app/graphql") {
        if (body) {
          const parsed = JSON.parse(body) as {
            query?: string;
            variables?: {
              input?: {
                agentSessionId?: string;
                issueId?: string;
                url?: string;
                title?: string;
                content?: { type: string; body?: string };
              };
            };
          };
          const input = parsed.variables?.input;
          if (parsed.query?.includes("agentActivityCreate") && input) {
            linearCalls.push({
              agentSessionId: input.agentSessionId ?? "",
              content: input.content ?? { type: "" },
            });
            return new Response(
              JSON.stringify({
                data: { agentActivityCreate: { success: true } },
              }),
              { status: 200 },
            );
          }
          if (parsed.query?.includes("attachmentCreate") && input) {
            githubCalls.push({ url: "linear-attachment", body });
            return new Response(
              JSON.stringify({
                data: {
                  attachmentCreate: {
                    success: true,
                    attachment: { id: "att-1", url: input.url },
                  },
                },
              }),
              { status: 200 },
            );
          }
        }
        return new Response("{}", { status: 200 });
      }

      if (url.endsWith("/run")) {
        return new Response(
          buildSseBodyStream([
            { type: "assistant_msg", text: "Fixed the bug." },
            { type: "turn_end", turn: 1, reason: "completed" },
            {
              type: "result",
              exit_code: 0,
              duration_ms: 5000,
              branch: "linear/sym-1",
              pr_url: null,
            },
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }

      if (url.startsWith("https://api.github.com")) {
        githubCalls.push({ url, body: body ?? undefined });
        if (url.endsWith("/pulls")) {
          return new Response(
            JSON.stringify({
              html_url: "https://github.com/markoinla/symphony/pull/99",
              number: 99,
            }),
            { status: 201 },
          );
        }
        if (url.endsWith("/labels")) {
          return new Response("[]", { status: 200 });
        }
      }

      throw new Error(`unexpected fetch in test: ${url}`);
    });

    const env = makeEnv(kv, { GITHUB_TOKEN: "ghp_test" }, db);
    const runner = buildRunner(env);
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-pr",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);

    expect(result.status).toBe("ok");
    expect(result.pr_url).toBe("https://github.com/markoinla/symphony/pull/99");
    expect(ran).toContain("create-pr-and-attach");

    // Three github calls expected: PR create, label add, plus the
    // Linear attachment mutation (logged as "linear-attachment").
    const prCall = githubCalls.find((c) => c.url.endsWith("/pulls"));
    const labelCall = githubCalls.find((c) => c.url.endsWith("/labels"));
    const attachCall = githubCalls.find((c) => c.url === "linear-attachment");
    expect(prCall).toBeDefined();
    expect(labelCall).toBeDefined();
    expect(attachCall).toBeDefined();
    const labelBody = JSON.parse(labelCall?.body ?? "{}");
    expect(labelBody.labels).toEqual(["symphony"]);

    // Response activity should include the PR URL in its body.
    const responseCall = linearCalls.find(
      (c) => c.content.type === "response",
    );
    expect(responseCall?.content.body).toContain(
      "https://github.com/markoinla/symphony/pull/99",
    );
  });

  it("skips PR creation when GITHUB_TOKEN is unset", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({
      dispatcherEvents: [
        { type: "assistant_msg", text: "Done." },
        { type: "turn_end", turn: 1, reason: "completed" },
        {
          type: "result",
          exit_code: 0,
          duration_ms: 5000,
          branch: "linear/sym-1",
          pr_url: null,
        },
      ],
    });

    const env = makeEnv(kv, {}, db);
    delete (env as Partial<Env>).GITHUB_TOKEN;
    const runner = buildRunner(env);
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-no-token",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result.pr_url).toBeNull();
    expect(ran).not.toContain("create-pr-and-attach");
  });

  it("skips PR creation when result has no branch (no changes)", async () => {
    const kv = new FakeKV();
    const db = seededDb();
    installFetchMock({
      dispatcherEvents: [
        { type: "assistant_msg", text: "Nothing to change." },
        { type: "turn_end", turn: 1, reason: "completed" },
        {
          type: "result",
          exit_code: 0,
          duration_ms: 5000,
          branch: null,
          pr_url: null,
        },
      ],
    });

    const env = makeEnv(kv, { GITHUB_TOKEN: "ghp_test" }, db);
    const runner = buildRunner(env);
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-no-branch",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result.pr_url).toBeNull();
    expect(ran).not.toContain("create-pr-and-attach");
  });
});

describe("SessionRunner.run — multi-turn loop", () => {
  it("re-dispatches when a turn ends with needs_continuation", async () => {
    const kv = new FakeKV();
    const db = seededDb();

    // Two dispatcher calls expected: turn 1 needs continuation, turn 2
    // completes. The fetch mock returns a different SSE script per
    // call by counting invocations.
    let runCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = init?.body as string | undefined;

      if (url === "https://api.linear.app/graphql") {
        if (body) {
          const parsed = JSON.parse(body) as {
            variables?: {
              input?: {
                agentSessionId: string;
                content: { type: string; body?: string };
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
        runCalls++;
        const events: NormalizedEvent[] =
          runCalls === 1
            ? [
                { type: "assistant_msg", text: "Partial work done." },
                { type: "turn_end", turn: 1, reason: "needs_continuation" },
                {
                  type: "result",
                  exit_code: 0,
                  duration_ms: 1000,
                  branch: null,
                  pr_url: null,
                },
              ]
            : [
                { type: "assistant_msg", text: "All done." },
                { type: "turn_end", turn: 2, reason: "completed" },
                {
                  type: "result",
                  exit_code: 0,
                  duration_ms: 2000,
                  branch: null,
                  pr_url: null,
                },
              ];
        return new Response(buildSseBodyStream(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    });

    const runner = buildRunner(makeEnv(kv, {}, db));
    const { step, ran } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-multi",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result).toEqual({
      status: "ok",
      exit_code: 0,
      turns: 2,
      pr_url: null,
    });
    expect(ran).toContain("turn-1");
    expect(ran).toContain("turn-2");
    expect(runCalls).toBe(2);
    // The final response should reflect the LAST assistant message.
    const lastCall = linearCalls[linearCalls.length - 1];
    expect(lastCall?.content.type).toBe("response");
    expect(lastCall?.content.body).toBe("All done.");
  });

  it("stops at max_turns and uses the last assistant message", async () => {
    const kv = new FakeKV();

    // Always returns needs_continuation; we cap at 2.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = init?.body as string | undefined;

      if (url === "https://api.linear.app/graphql") {
        if (body) {
          const parsed = JSON.parse(body) as {
            variables?: {
              input?: { agentSessionId: string; content: { type: string; body?: string } };
            };
          };
          const input = parsed.variables?.input;
          if (input) linearCalls.push(input);
        }
        return new Response(
          JSON.stringify({ data: { agentActivityCreate: { success: true } } }),
          { status: 200 },
        );
      }

      if (url.endsWith("/run")) {
        return new Response(
          buildSseBodyStream([
            { type: "assistant_msg", text: "still going" },
            { type: "turn_end", turn: 1, reason: "needs_continuation" },
            { type: "result", exit_code: 0, duration_ms: 500, branch: null, pr_url: null },
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

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
      max_turns: 2,
      scope: null,
      system_prompt_override: null,
      created_at: NOW_SEC(),
      updated_at: NOW_SEC(),
    });
    const env = makeEnv(kv, {}, db);
    const runner = buildRunner(env);
    const { step } = makeStep();

    const event: AgentSessionEventWebhook = {
      type: "AgentSessionEvent",
      organizationId: LINEAR_ORG_ID,
      action: "created",
      webhookId: "wh-max",
      agentSession: baseSession,
      promptContext: baseSession.promptContext,
    };

    const result = await runner.run(makeEvent(event), step as never);
    expect(result.turns).toBe(2);
    const lastCall = linearCalls[linearCalls.length - 1];
    expect(lastCall?.content.type).toBe("error");
    expect(lastCall?.content.body).toContain("max_turns_reached");
  });
});
