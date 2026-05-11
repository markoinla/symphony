import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type Env } from "../src/index";
import { computeLinearSignature } from "../src/lib/signature";
import { FakeD1 } from "./helpers/fake-d1";

// Integration test for SYM-295 track 3 — the webhook router. Confirms
// that a Linear `Issue update` with `updatedFrom.stateId` is
// normalized to `state_entered: Todo`, resolved against the seeded
// "Engineering Default" workflow, and dispatched to SESSION_RUNNER
// with a `workflowConfig` matching the seed.
//
// The resolver + seed modules are mocked so this test exercises only
// the wiring inside `tryDispatchWorkflow` (normalize → seed → resolve
// → dispatch). End-to-end SQL behavior is verified by Track 1's
// resolver/seed unit tests.

const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
const STATE_ENTERED_TODO_PATH = path.join(
  FIXTURES,
  "fixtures",
  "webhook-state-entered-todo.json",
);

const LINEAR_SECRET = "linear-webhook-secret";
const HMAC_SECRET = "dispatch-hmac-secret";

// Mock the resolver: the seeded "Engineering Default" only has a
// `state_entered to_state=Todo` trigger that fires `start_session`, so
// the mock returns that match for state_entered+Todo events and null
// for everything else.
vi.mock("../src/lib/workflows/resolver", () => {
  return {
    resolveWorkflow: vi.fn(async (_env: unknown, event: { event_type: string; to_state?: string }) => {
      if (event.event_type !== "state_entered" || event.to_state !== "Todo") {
        return null;
      }
      return {
        workflow: {
          id: "wf-seed",
          organization_id: "linear-org-1",
          team_id: null,
          user_id: null,
          name: "Engineering Default",
          description: "seed",
          engine: "pi",
          model: null,
          max_turns: 10,
          max_continuations: 5,
          allowed_tools: null,
          disallowed_tools: null,
          allowed_domains: null,
          mcp_servers: null,
          permission_mode: null,
          additional_read_paths: null,
          additional_write_paths: null,
          hook_after_create: null,
          hook_before_remove: null,
          hook_timeout_ms: 300000,
          prompt_template:
            "You are working on {{ issue.identifier }} - {{ issue.title }}.",
          version: 1,
          status: "published",
          published_at: 0,
          created_at: 0,
          updated_at: 0,
        },
        trigger: {
          id: "trg-todo",
          workflow_id: "wf-seed",
          event_type: "state_entered",
          to_state: "Todo",
          from_state: null,
          label_name: null,
          comment_match: null,
          team_filter: null,
          project_filter: null,
          label_filter: null,
          skip_label_filter: null,
          assignee_filter: null,
          action: "start_session",
          action_params: null,
          priority: 50,
          enabled: true,
          created_at: 0,
          updated_at: 0,
        },
      };
    }),
  };
});

vi.mock("../src/lib/workflows/seed", () => ({
  ensureDefaultWorkflow: vi.fn(async () => {}),
}));

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
  return { create: vi.fn().mockResolvedValue({ id: "stub-instance" }) };
}

function makeEnv(
  kv: FakeKV,
  sessionRunner: WorkflowStub,
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
  };
}

async function signedRequest(body: unknown): Promise<Request> {
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

function makeExecCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /webhook — workflow router (SYM-295)", () => {
  it("normalizes a state_entered: Todo Linear payload, resolves the seed, and dispatches start_session with workflowConfig", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const runner = makeWorkflowStub();
    const env = makeEnv(kv, runner);

    const fixture = JSON.parse(readFileSync(STATE_ENTERED_TODO_PATH, "utf8"));
    const res = await app.fetch(await signedRequest(fixture), env, makeExecCtx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, via: "workflow" });

    expect(runner.create).toHaveBeenCalledTimes(1);
    const call = runner.create.mock.calls[0]![0] as {
      id: string;
      params: Record<string, unknown>;
    };
    expect(call.id).toMatch(/^linear-org-1:issue-uuid-1:\d+$/);

    const workflowConfig = call.params.workflowConfig as Record<string, unknown>;
    expect(workflowConfig).toMatchObject({
      id: "wf-seed",
      engine: "pi",
      max_turns: 10,
      max_continuations: 5,
      hook_timeout_ms: 300000,
    });
    expect(workflowConfig.prompt_template).toMatch(/issue\.identifier/);

    const event = call.params.event as {
      type: string;
      organizationId: string;
      agentSession: { id: string; issue: { identifier: string; title: string } };
    };
    expect(event.type).toBe("AgentSessionEvent");
    expect(event.organizationId).toBe("linear-org-1");
    expect(event.agentSession.issue.identifier).toBe("SYM-42");
  });

  it("ignores deliveries that don't match any workflow and don't carry an AgentSessionEvent", async () => {
    const { resolveWorkflow } = await import("../src/lib/workflows/resolver");
    const mock = resolveWorkflow as unknown as ReturnType<typeof vi.fn>;
    const original = mock.getMockImplementation();
    mock.mockResolvedValue(null);

    try {
      const app = buildApp();
      const kv = new FakeKV();
      const runner = makeWorkflowStub();
      const env = makeEnv(kv, runner);

      const fixture = JSON.parse(readFileSync(STATE_ENTERED_TODO_PATH, "utf8"));
      const res = await app.fetch(await signedRequest(fixture), env, makeExecCtx());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true });
      expect(runner.create).not.toHaveBeenCalled();
    } finally {
      if (original) mock.mockImplementation(original);
    }
  });
});
