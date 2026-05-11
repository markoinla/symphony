// Dispatch the action a matched trigger asked for. Today only
// `start_session` is wired end-to-end: it spawns a `SESSION_RUNNER`
// Workflow instance carrying the resolved workflow's config so the
// runner uses it instead of the legacy project columns.
//
// The other actions (`continue_session`, `reset_session`, etc.) log a
// `deferred` line and return — the resolver/dispatcher are part of
// SYM-295 but the session-identity model for non-start actions lands
// in a follow-up issue.

import type { Env } from "../../index";
import type { EventTuple, IssueRef } from "../../schemas/event";
import type { Trigger } from "../../schemas/trigger";
import type { Workflow } from "../../schemas/workflow";
import type { WorkflowConfigSubset } from "../../workflows/session-runner";

export interface DispatchArgs {
  env: Env;
  workflow: Workflow;
  trigger: Trigger;
  event: EventTuple;
}

/**
 * Dispatch the trigger's `action` against the resolved workflow. Only
 * `start_session` is implemented today.
 */
export async function dispatchAction(args: DispatchArgs): Promise<void> {
  const { env, workflow, trigger, event } = args;

  switch (trigger.action) {
    case "start_session":
      await startSession(env, workflow, event);
      return;
    case "continue_session":
    case "reset_session":
    case "stop_session":
    case "post_comment":
    case "transition_to":
      console.info("action_deferred_to_followup", {
        action: trigger.action,
        workflow_id: workflow.id,
        issue_id: getIssueId(event),
      });
      return;
    default: {
      const action: string = trigger.action;
      console.warn("unknown_trigger_action", { action });
      return;
    }
  }
}

async function startSession(
  env: Env,
  workflow: Workflow,
  event: EventTuple,
): Promise<void> {
  const issueId = getIssueId(event) ?? "no-issue";
  const instanceId = `${event.organization_id}:${issueId}:${Date.now()}`;
  const workflowConfig = pickWorkflowConfig(workflow);

  try {
    await env.SESSION_RUNNER.create({
      id: instanceId,
      params: {
        // The runner's legacy entry point keys off `event.agentSession`,
        // so we hand it a synthesized envelope that carries the
        // workflow config. The runner branches on `workflowConfig`
        // before reading project columns.
        event: synthesizeRunnerEvent(event),
        workflowConfig,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/instance.*exists|already/i.test(msg)) {
      console.info("workflow_already_exists", instanceId);
      return;
    }
    console.error("workflow_create_failed", msg);
    throw e;
  }
}

/**
 * Subset of the workflow row the runner needs to dispatch. Mirrors the
 * fields Symphony's WORKFLOW.md exposes. Kept in dispatch (not on the
 * Workflow row) so the runner doesn't need to import the whole Drizzle
 * entity.
 */
export function pickWorkflowConfig(workflow: Workflow): WorkflowConfigSubset {
  return {
    id: workflow.id,
    engine: workflow.engine,
    model: workflow.model ?? null,
    max_turns: workflow.max_turns ?? null,
    max_continuations: workflow.max_continuations ?? null,
    prompt_template: workflow.prompt_template ?? null,
    allowed_tools: workflow.allowed_tools ?? null,
    disallowed_tools: workflow.disallowed_tools ?? null,
    permission_mode: workflow.permission_mode ?? null,
    allowed_domains: workflow.allowed_domains ?? null,
    additional_read_paths: workflow.additional_read_paths ?? null,
    additional_write_paths: workflow.additional_write_paths ?? null,
    hook_after_create: workflow.hook_after_create ?? null,
    hook_before_remove: workflow.hook_before_remove ?? null,
    hook_timeout_ms: workflow.hook_timeout_ms ?? null,
    mcp_servers: workflow.mcp_servers ?? null,
  };
}

function getIssue(event: EventTuple): IssueRef | null {
  return event.issue ?? null;
}

function getIssueId(event: EventTuple): string | null {
  return getIssue(event)?.id ?? null;
}

function synthesizeRunnerEvent(event: EventTuple): {
  type: "AgentSessionEvent";
  action: "created";
  webhookId: string;
  organizationId: string;
  agentSession: {
    id: string;
    issue?: {
      id: string;
      identifier: string;
      title: string;
      teamId?: string;
    };
    promptContext?: string;
  };
} {
  const issue = getIssue(event);
  const sessionId =
    (event as { agent_session_id?: string | null }).agent_session_id ??
    `synthetic:${event.event_type}:${issue?.id ?? "noissue"}:${Date.now()}`;
  return {
    type: "AgentSessionEvent",
    action: "created",
    webhookId: `dispatch:${sessionId}`,
    organizationId: event.organization_id,
    agentSession: {
      id: sessionId,
      ...(issue
        ? {
            issue: {
              id: issue.id,
              identifier: issue.identifier ?? issue.id,
              title: issue.title ?? "",
              teamId: issue.team_id ?? undefined,
            },
          }
        : {}),
    },
  };
}
