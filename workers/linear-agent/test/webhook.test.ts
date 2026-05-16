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

type ResolverRow = Record<string, string | number | null>;

class ResolverFakeD1 extends FakeD1 {
  workflows = new Map<string, ResolverRow>();
  triggers: ResolverRow[] = [];

  override prepare(sql: string): any {
    if (/FROM workflow_triggers t\s+JOIN workflows w/i.test(sql.replace(/\s+/g, " "))) {
      return new ResolverStatement(this);
    }
    return super.prepare(sql);
  }
}

class ResolverStatement {
  private bindings: unknown[] = [];

  constructor(private db: ResolverFakeD1) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async all<T>(): Promise<{ success: true; results: T[] }> {
    const [eventType, orgId, teamId, userId, toState, fromState, labelName] =
      this.bindings as [string, string | null, string | null, string | null, string | null, string | null, string | null];
    const rows = this.db.triggers
      .map((t) => ({ t, w: this.db.workflows.get(String(t.workflow_id)) }))
      .filter(({ t, w }) => {
        if (!w) return false;
        const scope =
          (w.organization_id != null && w.organization_id === orgId) ||
          (w.team_id != null && w.team_id === teamId) ||
          (w.user_id != null && w.user_id === userId);
        return (
          t.enabled === 1 &&
          w.status === "published" &&
          t.event_type === eventType &&
          scope &&
          (t.to_state == null || t.to_state === toState) &&
          (t.from_state == null || t.from_state === fromState) &&
          (t.label_name == null || t.label_name === labelName)
        );
      })
      .map(({ t, w }) => ({
        t_id: t.id,
        t_workflow_id: t.workflow_id,
        t_event_type: t.event_type,
        t_to_state: t.to_state,
        t_from_state: t.from_state,
        t_label_name: t.label_name,
        t_comment_match: t.comment_match,
        t_team_filter: t.team_filter,
        t_project_filter: t.project_filter,
        t_label_filter: t.label_filter,
        t_skip_label_filter: t.skip_label_filter,
        t_assignee_filter: t.assignee_filter,
        t_repo_filter: t.repo_filter,
        t_branch_filter: t.branch_filter,
        t_base_filter: t.base_filter,
        t_draft_filter: t.draft_filter,
        t_author_filter: t.author_filter,
        t_action: t.action,
        t_action_params: t.action_params,
        t_priority: t.priority,
        t_enabled: t.enabled,
        t_created_at: t.created_at,
        t_updated_at: t.updated_at,
        w_id: w!.id,
        w_organization_id: w!.organization_id,
        w_team_id: w!.team_id,
        w_user_id: w!.user_id,
        w_name: w!.name,
        w_description: w!.description,
        w_engine: w!.engine,
        w_model: w!.model,
        w_max_turns: w!.max_turns,
        w_max_continuations: w!.max_continuations,
        w_allowed_tools: w!.allowed_tools,
        w_disallowed_tools: w!.disallowed_tools,
        w_allowed_domains: w!.allowed_domains,
        w_mcp_servers: w!.mcp_servers,
        w_permission_mode: w!.permission_mode,
        w_additional_read_paths: w!.additional_read_paths,
        w_additional_write_paths: w!.additional_write_paths,
        w_hook_after_create: w!.hook_after_create,
        w_hook_before_remove: w!.hook_before_remove,
        w_hook_timeout_ms: w!.hook_timeout_ms,
        w_prompt_template: w!.prompt_template,
        w_version: w!.version,
        w_status: w!.status,
        w_published_at: w!.published_at,
        w_created_at: w!.created_at,
        w_updated_at: w!.updated_at,
        scope_tier: w!.user_id != null ? 2 : w!.team_id != null ? 1 : 0,
      }));
    rows.sort((a, b) => Number(b.t_priority) - Number(a.t_priority));
    return { success: true, results: rows as T[] };
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

async function signedGitHubSourceRequest(
  sourceId: string,
  secret: string,
  eventName: string,
  body: Record<string, unknown>,
): Promise<Request> {
  const raw = JSON.stringify(body);
  const sig = `sha256=${await computeLinearSignature(secret, raw)}`;
  return new Request(`https://agent.example/webhook/source/${sourceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": eventName,
      "X-GitHub-Delivery": crypto.randomUUID(),
      "X-Hub-Signature-256": sig,
    },
    body: raw,
  });
}

function seedGitHubTriggerDb(eventType: string, commentMatch?: string): ResolverFakeD1 {
  const now = Math.floor(Date.now() / 1000);
  const db = new ResolverFakeD1();
  db.webhookSources.set("source-gh", {
    id: "source-gh",
    organization_id: "org-1",
    kind: "github",
    name: "GitHub",
    enabled: 1,
    secret: "github-secret",
    project_id: null,
    config: null,
    created_at: now,
    updated_at: now,
    last_used_at: null,
  });
  db.projects.set("org-1:team-1", {
    id: "project-1",
    organization_id: "org-1",
    linear_team_id: "team-1",
    linear_team_name: "Team One",
    repo_url: "https://github.com/acme/widgets.git",
    default_branch: "main",
    engine: "pi",
    model: null,
    max_turns: 10,
    scope: "default",
    system_prompt_override: null,
    created_at: now,
    updated_at: now,
  });
  db.workflows.set("workflow-1", {
    id: "workflow-1",
    organization_id: "org-1",
    team_id: null,
    user_id: null,
    name: "GitHub issue workflow",
    description: null,
    engine: "pi",
    model: null,
    max_turns: 1,
    max_continuations: null,
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
    prompt_template: "Issue {{ issue.title }} {{ issue.body }} {{ issue.state }}",
    version: 1,
    status: "published",
    published_at: now,
    created_at: now,
    updated_at: now,
  });
  db.triggers.push({
    id: "trigger-1",
    workflow_id: "workflow-1",
    event_type: eventType,
    to_state: null,
    from_state: null,
    label_name: null,
    comment_match: commentMatch ?? null,
    team_filter: null,
    project_filter: null,
    label_filter: JSON.stringify(["agent"]),
    skip_label_filter: null,
    assignee_filter: null,
    repo_filter: JSON.stringify(["acme/widgets"]),
    branch_filter: null,
    base_filter: null,
    draft_filter: null,
    author_filter: JSON.stringify(["octocat"]),
    action: "start_session",
    action_params: null,
    priority: 0,
    enabled: 1,
    created_at: now,
    updated_at: now,
  });
  return db;
}

function githubIssueBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: { full_name: "acme/widgets" },
    issue: {
      number: 7,
      title: "Fix issue",
      body: "Issue details",
      state: "open",
      labels: [{ name: "agent" }],
      user: { login: "octocat" },
      assignees: [],
    },
    sender: { login: "octocat" },
    ...overrides,
  };
}

function githubIssueCommentBody(body: string) {
  return {
    action: "created",
    repository: { full_name: "acme/widgets" },
    issue: {
      number: 7,
      title: "Fix issue",
      body: "Issue details",
      state: "open",
      labels: [{ name: "agent" }],
      user: { login: "octocat" },
      assignees: [],
    },
    comment: { id: 123, body },
    sender: { login: "monalisa" },
  };
}

const GITHUB_APP_WEBHOOK_SECRET = "app-webhook-secret";

async function signedGitHubAppRequest(
  secret: string,
  eventName: string,
  body: Record<string, unknown>,
): Promise<Request> {
  const raw = JSON.stringify(body);
  const sig = `sha256=${await computeLinearSignature(secret, raw)}`;
  return new Request("https://agent.example/webhook/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": eventName,
      "X-GitHub-Delivery": crypto.randomUUID(),
      "X-Hub-Signature-256": sig,
    },
    body: raw,
  });
}

function githubPrBody(
  installationId: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    action: "opened",
    repository: { full_name: "acme/widgets" },
    pull_request: {
      number: 42,
      title: "Add widget",
      body: "Details",
      state: "open",
      merged: false,
      base: { ref: "main" },
      head: { ref: "feature/widget", sha: "abc123" },
      draft: false,
      labels: [{ name: "agent" }],
      user: { login: "octocat" },
      requested_reviewers: [],
    },
    installation: { id: installationId },
    sender: { login: "octocat" },
    ...overrides,
  };
}

function seedGitHubInstall(
  db: ResolverFakeD1,
  installId: number,
  orgId: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.githubInstalls.set(orgId, {
    id: `ghinstall-${installId}`,
    organization_id: orgId,
    install_id: installId,
    account_login: "acme",
    account_type: "Organization",
    repo_selection: "all",
    selected_repos: null,
    created_at: now,
    updated_at: now,
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

describe("POST /webhook/source GitHub issue triggers", () => {
  it("runs SessionRunner for a matching HMAC-signed issues.opened webhook", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner = makeWorkflowStub();
    const db = seedGitHubTriggerDb("github.issue.opened");

    const res = await app.fetch(
      await signedGitHubSourceRequest(
        "source-gh",
        "github-secret",
        "issues",
        githubIssueBody(),
      ),
      makeEnv(kv, {}, sessionRunner, db),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      matched: true,
      workflow_id: "workflow-1",
      trigger_id: "trigger-1",
      outcome: "start_session",
    });
    expect(sessionRunner.create).toHaveBeenCalledWith({
      id: expect.any(String),
      params: expect.objectContaining({
        mode: "trigger",
        issueIdentifier: "acme/widgets#7",
        prompt: "Issue Fix issue Issue details open",
      }),
    });
  });

  it("fires issue_comment.created only when comment_match matches", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner = makeWorkflowStub();
    const db = seedGitHubTriggerDb("github.issue.commented", "^/symphony\\b");
    const env = makeEnv(kv, {}, sessionRunner, db);

    const matched = await app.fetch(
      await signedGitHubSourceRequest(
        "source-gh",
        "github-secret",
        "issue_comment",
        githubIssueCommentBody("/symphony help"),
      ),
      env,
      makeExecCtx(),
    );
    expect(matched.status).toBe(200);
    expect(await matched.json()).toMatchObject({ matched: true });
    expect(sessionRunner.create).toHaveBeenCalledTimes(1);

    const skipped = await app.fetch(
      await signedGitHubSourceRequest(
        "source-gh",
        "github-secret",
        "issue_comment",
        githubIssueCommentBody("hello"),
      ),
      env,
      makeExecCtx(),
    );
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ matched: false });
    expect(sessionRunner.create).toHaveBeenCalledTimes(1);
  });
});

describe("POST /webhook/github App-level webhook", () => {
  it("returns 503 when GITHUB_APP_WEBHOOK_SECRET is unset", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const db = seedGitHubTriggerDb("github.pr.opened");
    seedGitHubInstall(db, 555, "org-1");

    const res = await app.fetch(
      await signedGitHubAppRequest(
        GITHUB_APP_WEBHOOK_SECRET,
        "pull_request",
        githubPrBody(555),
      ),
      makeEnv(kv, {}, makeWorkflowStub(), db),
      makeExecCtx(),
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "github_webhook_not_configured",
    });
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const db = seedGitHubTriggerDb("github.pr.opened");
    seedGitHubInstall(db, 555, "org-1");

    const res = await app.fetch(
      await signedGitHubAppRequest(
        "wrong-secret",
        "pull_request",
        githubPrBody(555),
      ),
      makeEnv(
        kv,
        { GITHUB_APP_WEBHOOK_SECRET },
        makeWorkflowStub(),
        db,
      ),
      makeExecCtx(),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("dispatches a matching PR event under the org resolved from installation.id", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner = makeWorkflowStub();
    const db = seedGitHubTriggerDb("github.pr.opened");
    seedGitHubInstall(db, 555, "org-1");

    const res = await app.fetch(
      await signedGitHubAppRequest(
        GITHUB_APP_WEBHOOK_SECRET,
        "pull_request",
        githubPrBody(555),
      ),
      makeEnv(kv, { GITHUB_APP_WEBHOOK_SECRET }, sessionRunner, db),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      matched: true,
      workflow_id: "workflow-1",
      trigger_id: "trigger-1",
      outcome: "start_session",
    });
    expect(sessionRunner.create).toHaveBeenCalledTimes(1);
  });

  it("ignores deliveries from an unregistered installation", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner = makeWorkflowStub();
    const db = seedGitHubTriggerDb("github.pr.opened");
    seedGitHubInstall(db, 555, "org-1");

    const res = await app.fetch(
      await signedGitHubAppRequest(
        GITHUB_APP_WEBHOOK_SECRET,
        "pull_request",
        githubPrBody(999),
      ),
      makeEnv(kv, { GITHUB_APP_WEBHOOK_SECRET }, sessionRunner, db),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
    expect(sessionRunner.create).not.toHaveBeenCalled();
  });

  it("acknowledges the ping event without dispatching", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner = makeWorkflowStub();
    const db = seedGitHubTriggerDb("github.pr.opened");
    seedGitHubInstall(db, 555, "org-1");

    const res = await app.fetch(
      await signedGitHubAppRequest(GITHUB_APP_WEBHOOK_SECRET, "ping", {
        zen: "Keep it logically awesome.",
        hook_id: 1,
      }),
      makeEnv(kv, { GITHUB_APP_WEBHOOK_SECRET }, sessionRunner, db),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
    expect(sessionRunner.create).not.toHaveBeenCalled();
  });

  it("does not dispatch another tenant's workflow for a PR from a different installation", async () => {
    const app = buildApp();
    const kv = new FakeKV();
    const sessionRunner = makeWorkflowStub();
    // workflow-1 / trigger-1 belong to org-1. Installation 777 is
    // registered to org-2, so its PR must not resolve org-1's workflow.
    const db = seedGitHubTriggerDb("github.pr.opened");
    seedGitHubInstall(db, 555, "org-1");
    seedGitHubInstall(db, 777, "org-2");

    const res = await app.fetch(
      await signedGitHubAppRequest(
        GITHUB_APP_WEBHOOK_SECRET,
        "pull_request",
        githubPrBody(777),
      ),
      makeEnv(kv, { GITHUB_APP_WEBHOOK_SECRET }, sessionRunner, db),
      makeExecCtx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, matched: false });
    expect(sessionRunner.create).not.toHaveBeenCalled();
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
      linear_issue_identifier: null,
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

    // Dispatcher was told to stop the per-run sandbox. The sandbox is
    // keyed by the run id (= session id), not the issue identifier.
    expect(dispatcherCalls.length).toBe(1);
    expect((dispatcherCalls[0]!.body as { run_id: string }).run_id).toBe(
      sessionId,
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
