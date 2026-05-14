import { describe, expect, it, vi, afterEach } from "vitest";
import { dispatchTrigger } from "../src/lib/dispatch-trigger";
import type { Env } from "../src/index";
import type { EventTuple } from "../src/schemas/event";
import type { Trigger } from "../src/schemas/trigger";
import type { Workflow } from "../src/schemas/workflow";
import { FakeD1 } from "./helpers/fake-d1";

function makeEnv(db: FakeD1, create: ReturnType<typeof vi.fn>): Env {
  return {
    DB: db as unknown as D1Database,
    SESSION_RUNNER: { create },
    DISPATCHER_URL: "https://dispatcher.example",
    DISPATCH_HMAC_SECRET: "hmac-secret",
  } as unknown as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchTrigger", () => {
  it("snapshots dispatcher-supported workflow policy fields onto runner params", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = new FakeD1();
    db.projects.set("org-1:team-1", {
      id: "project-1",
      organization_id: "org-1",
      linear_team_id: "team-1",
      linear_team_name: "Team One",
      repo_url: "https://github.com/acme/repo.git",
      default_branch: "main",
      engine: "pi",
      model: null,
      max_turns: 10,
      scope: "team-scope",
      system_prompt_override: null,
      created_at: now,
      updated_at: now,
    });
    db.linearAgentInstalls.set("org-1", {
      id: "install-1",
      organization_id: "org-1",
      linear_organization_id: "linear-org-1",
      access_token: "linear-token",
      refresh_token: null,
      scopes: "read,write",
      installed_by_user_id: "user-1",
      status: "active",
      installed_at: now,
      refreshed_at: now,
      expires_at: now + 3600,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            agentSessionCreateOnIssue: {
              success: true,
              agentSession: { id: "linear-session-1" },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const create = vi.fn().mockResolvedValue(undefined);
    const workflow: Workflow = {
      id: "workflow-1",
      organization_id: "org-1",
      team_id: null,
      user_id: null,
      name: "Policy workflow",
      description: null,
      engine: "pi",
      model: "model-from-workflow",
      max_turns: 3,
      max_continuations: null,
      allowed_tools: ["Read", "Bash"],
      disallowed_tools: ["WebFetch"],
      allowed_domains: null,
      mcp_servers: null,
      permission_mode: "ask",
      additional_read_paths: null,
      additional_write_paths: null,
      hook_after_create: null,
      hook_before_remove: null,
      hook_timeout_ms: 300000,
      prompt_template: "Do {{ issue.title }}",
      version: 1,
      status: "published",
      published_at: now,
      created_at: now,
      updated_at: now,
    };
    const trigger: Trigger = {
      id: "trigger-1",
      workflow_id: "workflow-1",
      event_type: "state_entered",
      to_state: "Todo",
      from_state: null,
      label_name: null,
      team_filter: null,
      project_filter: null,
      label_filter: null,
      skip_label_filter: null,
      assignee_filter: null,
      action: "start_session",
      action_params: null,
      priority: 0,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    const event: EventTuple = {
      event_type: "state_entered",
      organization_id: "org-1",
      team_id: "team-1",
      labels: [],
      issue: {
        id: "issue-1",
        identifier: "SYM-1",
        title: "the work",
        description: "details",
        team_id: "team-1",
        labels: [],
        comments: [],
      },
      to_state: "Todo",
      from_state: null,
    };

    const result = await dispatchTrigger(makeEnv(db, create), {
      workflow,
      trigger,
      event,
      linearOrganizationId: "linear-org-1",
    });

    expect(result).toEqual({
      outcome: "start_session",
      agentSessionId: "linear-session-1",
    });
    expect(create).toHaveBeenCalledWith({
      id: "linear-session-1",
      params: expect.objectContaining({
        mode: "agent_session",
        workflow_overrides: {
          engine: "pi",
          model: "model-from-workflow",
          max_turns: 3,
          name: "Policy workflow",
          allowed_tools: ["Read", "Bash"],
          disallowed_tools: ["WebFetch"],
          permission_mode: "ask",
        },
      }),
    });
  });
});
