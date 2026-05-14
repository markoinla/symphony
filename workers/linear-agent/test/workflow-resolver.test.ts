// Unit tests for the workflow resolver (SYM-295).
//
// The resolver issues a single parameterized SELECT joining
// workflow_triggers × workflows, evaluates event-specific match
// columns in SQL, and applies JSON-array scope filters in JS. These
// tests use a focused in-memory D1 mock that understands the resolver's
// single SELECT shape — broader D1 simulation lives in FakeD1.

import { describe, expect, it } from "vitest";

import { resolveWorkflow } from "../src/lib/workflows/resolver";
import type { EventTuple } from "../src/schemas/event";

// ── Mock D1 ────────────────────────────────────────────────────────

interface WorkflowRow {
  id: string;
  organization_id: string | null;
  team_id: string | null;
  user_id: string | null;
  name: string;
  description: string | null;
  engine: string;
  model: string | null;
  max_turns: number;
  max_continuations: number | null;
  allowed_tools: string | null;
  disallowed_tools: string | null;
  allowed_domains: string | null;
  mcp_servers: string | null;
  permission_mode: string | null;
  additional_read_paths: string | null;
  additional_write_paths: string | null;
  hook_after_create: string | null;
  hook_before_remove: string | null;
  hook_timeout_ms: number;
  prompt_template: string;
  version: number;
  status: string;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TriggerRow {
  id: string;
  workflow_id: string;
  event_type: string;
  to_state: string | null;
  from_state: string | null;
  label_name: string | null;
  team_filter: string | null;
  project_filter: string | null;
  label_filter: string | null;
  skip_label_filter: string | null;
  assignee_filter: string | null;
  action: string;
  action_params: string | null;
  priority: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface SelectArgs {
  eventType: string;
  orgId: string | null;
  teamId: string | null;
  userId: string | null;
  toState: string | null;
  fromState: string | null;
  labelName: string | null;
}

class MockResolverDB {
  workflows = new Map<string, WorkflowRow>();
  triggers: TriggerRow[] = [];

  addWorkflow(w: Partial<WorkflowRow> & { id: string }) {
    const full: WorkflowRow = {
      id: w.id,
      organization_id: w.organization_id ?? null,
      team_id: w.team_id ?? null,
      user_id: w.user_id ?? null,
      name: w.name ?? `workflow-${w.id}`,
      description: w.description ?? null,
      engine: w.engine ?? "pi",
      model: w.model ?? null,
      max_turns: w.max_turns ?? 10,
      max_continuations: w.max_continuations ?? null,
      allowed_tools: w.allowed_tools ?? null,
      disallowed_tools: w.disallowed_tools ?? null,
      allowed_domains: w.allowed_domains ?? null,
      mcp_servers: w.mcp_servers ?? null,
      permission_mode: w.permission_mode ?? null,
      additional_read_paths: w.additional_read_paths ?? null,
      additional_write_paths: w.additional_write_paths ?? null,
      hook_after_create: w.hook_after_create ?? null,
      hook_before_remove: w.hook_before_remove ?? null,
      hook_timeout_ms: w.hook_timeout_ms ?? 300000,
      prompt_template: w.prompt_template ?? "do {{issue.title}}",
      version: w.version ?? 1,
      status: w.status ?? "published",
      published_at: w.published_at ?? null,
      created_at: w.created_at ?? 0,
      updated_at: w.updated_at ?? 0,
    };
    this.workflows.set(full.id, full);
  }

  addTrigger(t: Partial<TriggerRow> & { id: string; workflow_id: string; event_type: string; action: string }) {
    this.triggers.push({
      to_state: null,
      from_state: null,
      label_name: null,
      team_filter: null,
      project_filter: null,
      label_filter: null,
      skip_label_filter: null,
      assignee_filter: null,
      action_params: null,
      priority: 0,
      enabled: 1,
      created_at: 0,
      updated_at: 0,
      ...t,
    });
  }

  prepare(sql: string) {
    return new MockStatement(this, sql);
  }
}

class MockStatement {
  private bindings: unknown[] = [];

  constructor(private db: MockResolverDB, private _sql: string) {}

  bind(...values: unknown[]) {
    this.bindings = values;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    // Resolver's SELECT order:
    //   [event_type, org_id, team_id, user_id,
    //    to_state, from_state, label_name]
    const [
      eventType,
      orgId,
      teamId,
      userId,
      toState,
      fromState,
      labelName,
    ] = this.bindings as [
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ];

    const args: SelectArgs = {
      eventType,
      orgId,
      teamId,
      userId,
      toState,
      fromState,
      labelName,
    };

    const candidates: Array<{ t: TriggerRow; w: WorkflowRow; scopeTier: number }> = [];

    for (const t of this.db.triggers) {
      if (t.enabled !== 1) continue;
      if (t.event_type !== args.eventType) continue;
      const w = this.db.workflows.get(t.workflow_id);
      if (!w) continue;
      if (w.status !== "published") continue;

      const inOrg = w.organization_id != null && w.organization_id === args.orgId;
      const inTeam = w.team_id != null && w.team_id === args.teamId;
      const inUser = w.user_id != null && w.user_id === args.userId;
      if (!inOrg && !inTeam && !inUser) continue;

      if (t.to_state != null && t.to_state !== args.toState) continue;
      if (t.from_state != null && t.from_state !== args.fromState) continue;
      if (t.label_name != null && t.label_name !== args.labelName) continue;

      const scopeTier = w.user_id != null ? 2 : w.team_id != null ? 1 : 0;
      candidates.push({ t, w, scopeTier });
    }

    candidates.sort((a, b) => {
      if (b.scopeTier !== a.scopeTier) return b.scopeTier - a.scopeTier;
      if (b.t.priority !== a.t.priority) return b.t.priority - a.t.priority;
      return a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0;
    });

    const rows = candidates.map(({ t, w, scopeTier }) => ({
      t_id: t.id,
      t_workflow_id: t.workflow_id,
      t_event_type: t.event_type,
      t_to_state: t.to_state,
      t_from_state: t.from_state,
      t_label_name: t.label_name,
      t_team_filter: t.team_filter,
      t_project_filter: t.project_filter,
      t_label_filter: t.label_filter,
      t_skip_label_filter: t.skip_label_filter,
      t_assignee_filter: t.assignee_filter,
      t_action: t.action,
      t_action_params: t.action_params,
      t_priority: t.priority,
      t_enabled: t.enabled,
      t_created_at: t.created_at,
      t_updated_at: t.updated_at,
      w_id: w.id,
      w_organization_id: w.organization_id,
      w_team_id: w.team_id,
      w_user_id: w.user_id,
      w_name: w.name,
      w_description: w.description,
      w_engine: w.engine,
      w_model: w.model,
      w_max_turns: w.max_turns,
      w_max_continuations: w.max_continuations,
      w_allowed_tools: w.allowed_tools,
      w_disallowed_tools: w.disallowed_tools,
      w_allowed_domains: w.allowed_domains,
      w_mcp_servers: w.mcp_servers,
      w_permission_mode: w.permission_mode,
      w_additional_read_paths: w.additional_read_paths,
      w_additional_write_paths: w.additional_write_paths,
      w_hook_after_create: w.hook_after_create,
      w_hook_before_remove: w.hook_before_remove,
      w_hook_timeout_ms: w.hook_timeout_ms,
      w_prompt_template: w.prompt_template,
      w_version: w.version,
      w_status: w.status,
      w_published_at: w.published_at,
      w_created_at: w.created_at,
      w_updated_at: w.updated_at,
      scope_tier: scopeTier,
    }));

    return { results: rows as unknown as T[] };
  }
}

function makeEnv(db: MockResolverDB) {
  return { DB: db as unknown as D1Database };
}

function stateEntered(overrides: Partial<EventTuple> = {}): EventTuple {
  return {
    event_type: "state_entered",
    organization_id: "org-1",
    team_id: null,
    project_id: null,
    user_id: null,
    assignee_id: null,
    labels: [],
    issue: null,
    actor_id: null,
    to_state: "Todo",
    from_state: null,
    ...overrides,
  } as EventTuple;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("resolveWorkflow — scope-tier precedence", () => {
  it("user-scoped workflow beats team-scoped beats org-scoped at the same event", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-org", organization_id: "org-1" });
    db.addWorkflow({ id: "wf-team", team_id: "team-1" });
    db.addWorkflow({ id: "wf-user", user_id: "user-1" });

    db.addTrigger({
      id: "t-org",
      workflow_id: "wf-org",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
      priority: 100,
    });
    db.addTrigger({
      id: "t-team",
      workflow_id: "wf-team",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
      priority: 0,
    });
    db.addTrigger({
      id: "t-user",
      workflow_id: "wf-user",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
      priority: -50,
    });

    const result = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ team_id: "team-1", user_id: "user-1" }),
    );
    expect(result?.workflow.id).toBe("wf-user");
  });

  it("team-scoped beats org-scoped when no user-scoped match exists", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-org", organization_id: "org-1" });
    db.addWorkflow({ id: "wf-team", team_id: "team-1" });
    db.addTrigger({
      id: "t-org",
      workflow_id: "wf-org",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
      priority: 999,
    });
    db.addTrigger({
      id: "t-team",
      workflow_id: "wf-team",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
      priority: 0,
    });

    const result = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ team_id: "team-1" }),
    );
    expect(result?.workflow.id).toBe("wf-team");
  });
});

describe("resolveWorkflow — priority tie-break", () => {
  it("higher priority wins at the same scope tier", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-a", organization_id: "org-1" });
    db.addWorkflow({ id: "wf-b", organization_id: "org-1" });
    db.addTrigger({
      id: "t-low",
      workflow_id: "wf-a",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
      priority: 1,
    });
    db.addTrigger({
      id: "t-high",
      workflow_id: "wf-b",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
      priority: 50,
    });

    const result = await resolveWorkflow(makeEnv(db), stateEntered());
    expect(result?.trigger.id).toBe("t-high");
  });
});

describe("resolveWorkflow — event_type match columns", () => {
  it("state_entered honors to_state — non-matching trigger is skipped", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-1", organization_id: "org-1" });
    db.addTrigger({
      id: "t-wrong",
      workflow_id: "wf-1",
      event_type: "state_entered",
      to_state: "InReview",
      action: "start_session",
    });
    db.addTrigger({
      id: "t-right",
      workflow_id: "wf-1",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
    });
    const result = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ to_state: "Todo" }),
    );
    expect(result?.trigger.id).toBe("t-right");
  });

  it("state_entered with NULL to_state matches any incoming state", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-1", organization_id: "org-1" });
    db.addTrigger({
      id: "t-any",
      workflow_id: "wf-1",
      event_type: "state_entered",
      action: "start_session",
    });
    const r1 = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ to_state: "Todo" }),
    );
    expect(r1?.trigger.id).toBe("t-any");
    const r2 = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ to_state: "Backlog" }),
    );
    expect(r2?.trigger.id).toBe("t-any");
  });

  it("label_added honors label_name", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-1", organization_id: "org-1" });
    db.addTrigger({
      id: "t-blocker",
      workflow_id: "wf-1",
      event_type: "label_added",
      label_name: "blocker",
      action: "start_session",
    });
    db.addTrigger({
      id: "t-bug",
      workflow_id: "wf-1",
      event_type: "label_added",
      label_name: "bug",
      action: "start_session",
    });

    const event: EventTuple = {
      event_type: "label_added",
      organization_id: "org-1",
      team_id: null,
      project_id: null,
      user_id: null,
      assignee_id: null,
      labels: [],
      issue: null,
      actor_id: null,
      label_name: "blocker",
      label_id: null,
    };
    const result = await resolveWorkflow(makeEnv(db), event);
    expect(result?.trigger.id).toBe("t-blocker");
  });

});

describe("resolveWorkflow — scope filters", () => {
  it("team_filter rejects when event's team is not in the list", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-1", organization_id: "org-1" });
    db.addTrigger({
      id: "t-1",
      workflow_id: "wf-1",
      event_type: "state_entered",
      to_state: "Todo",
      team_filter: JSON.stringify(["team-a"]),
      action: "start_session",
    });

    const miss = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ team_id: "team-b" }),
    );
    expect(miss).toBeNull();

    const hit = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ team_id: "team-a" }),
    );
    expect(hit?.trigger.id).toBe("t-1");
  });

  it("label_filter requires all labels present on the event", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-1", organization_id: "org-1" });
    db.addTrigger({
      id: "t-1",
      workflow_id: "wf-1",
      event_type: "state_entered",
      to_state: "Todo",
      label_filter: JSON.stringify(["agent", "ready"]),
      action: "start_session",
    });

    const partial = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ labels: ["agent"] }),
    );
    expect(partial).toBeNull();

    const full = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ labels: ["agent", "ready", "extra"] }),
    );
    expect(full?.trigger.id).toBe("t-1");
  });

  it("skip_label_filter rejects events that carry any listed label", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-1", organization_id: "org-1" });
    db.addTrigger({
      id: "t-1",
      workflow_id: "wf-1",
      event_type: "state_entered",
      to_state: "Todo",
      skip_label_filter: JSON.stringify(["wontfix"]),
      action: "start_session",
    });

    const skipped = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ labels: ["wontfix"] }),
    );
    expect(skipped).toBeNull();

    const ok = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ labels: ["agent"] }),
    );
    expect(ok?.trigger.id).toBe("t-1");
  });

  it("assignee_filter requires the event's assignee_id to match", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-1", organization_id: "org-1" });
    db.addTrigger({
      id: "t-1",
      workflow_id: "wf-1",
      event_type: "assignee_changed",
      assignee_filter: JSON.stringify(["user-x"]),
      action: "start_session",
    });

    const wrong: EventTuple = {
      event_type: "assignee_changed",
      organization_id: "org-1",
      team_id: null,
      project_id: null,
      user_id: null,
      assignee_id: "user-y",
      labels: [],
      issue: null,
      actor_id: null,
      to_assignee_id: "user-y",
      from_assignee_id: null,
    };
    expect(await resolveWorkflow(makeEnv(db), wrong)).toBeNull();

    const right: EventTuple = {
      ...wrong,
      assignee_id: "user-x",
      to_assignee_id: "user-x",
    };
    const r = await resolveWorkflow(makeEnv(db), right);
    expect(r?.trigger.id).toBe("t-1");
  });
});

describe("resolveWorkflow — workflow status / trigger.enabled gating", () => {
  it("draft workflows are not considered", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-draft", organization_id: "org-1", status: "draft" });
    db.addTrigger({
      id: "t-1",
      workflow_id: "wf-draft",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
    });
    expect(await resolveWorkflow(makeEnv(db), stateEntered())).toBeNull();
  });

  it("disabled triggers are not considered", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({ id: "wf-1", organization_id: "org-1" });
    db.addTrigger({
      id: "t-disabled",
      workflow_id: "wf-1",
      event_type: "state_entered",
      to_state: "Todo",
      action: "start_session",
      enabled: 0,
    });
    expect(await resolveWorkflow(makeEnv(db), stateEntered())).toBeNull();
  });
});

describe("resolveWorkflow — hydration", () => {
  it("parses JSON-encoded array columns on the returned workflow + trigger", async () => {
    const db = new MockResolverDB();
    db.addWorkflow({
      id: "wf-1",
      organization_id: "org-1",
      allowed_tools: JSON.stringify(["bash", "view"]),
      mcp_servers: JSON.stringify([{ name: "linear", url: "https://x" }]),
    });
    db.addTrigger({
      id: "t-1",
      workflow_id: "wf-1",
      event_type: "state_entered",
      to_state: "Todo",
      team_filter: JSON.stringify(["team-a"]),
      action_params: JSON.stringify({ comment: "starting" }),
      action: "start_session",
    });

    const r = await resolveWorkflow(
      makeEnv(db),
      stateEntered({ team_id: "team-a" }),
    );
    expect(r).not.toBeNull();
    expect(r!.workflow.allowed_tools).toEqual(["bash", "view"]);
    expect(r!.workflow.mcp_servers).toEqual([
      { name: "linear", url: "https://x" },
    ]);
    expect(r!.trigger.team_filter).toEqual(["team-a"]);
    expect(r!.trigger.action_params).toEqual({ comment: "starting" });
    expect(r!.trigger.enabled).toBe(true);
  });
});
