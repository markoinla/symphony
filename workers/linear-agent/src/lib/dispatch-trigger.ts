/**
 * Dispatch the action a resolved (workflow, trigger) pair calls for.
 *
 * The implementation mints a Linear AgentSession on the source issue
 * and then queues the existing `mode: "agent_session"` SessionRunner
 * flow with a synthesized webhook envelope. This way trigger-initiated
 * runs render in Linear's issue timeline exactly the same way as
 * @-mention sessions — the agent posts thoughts/responses/errors to
 * Linear, attaches the PR, transitions the issue to Human Review on
 * success, etc.
 *
 * Today only `action = "start_session"` is implemented. Other action
 * kinds return `{ outcome: "no_handler" }` and the caller records
 * that on the `webhook_events` row.
 */

import { createAgentSessionOnIssue } from "./activities";
import {
  refreshInstallToken,
  refreshInstallTokenIfNeeded,
} from "./install-token";
import { LinearAgentInstallStore } from "./store";

// Conservative timeout floor for the dispatch path. Mirrors the
// session-runner's `DEFAULT_TIMEOUT_MS` so a session-start-time refresh
// uses the same safety window the runner itself does.
const DISPATCH_RUN_TIMEOUT_MS = 10 * 60 * 1000;
import { renderPrompt } from "./workflows/render";
import { ProjectStore } from "./store";
import type { Env } from "../index";
import type { EventTuple } from "../schemas/event";
import type { Trigger } from "../schemas/trigger";
import type { Workflow } from "../schemas/workflow";
import type { AgentSessionEventWebhook } from "../types/agent-session";

export interface DispatchResult {
  /** `start_session`, `no_handler`, or `error`. */
  outcome: "start_session" | "no_handler" | "error";
  agentSessionId?: string;
  error?: string;
}

export async function dispatchTrigger(
  env: Env,
  args: {
    workflow: Workflow;
    trigger: Trigger;
    event: EventTuple;
    /**
     * Linear-side organization id from the inbound webhook. Required
     * to look up the install access token for the
     * `agentSessionCreateOnIssue` mutation. The webhook handler
     * computes this once during tenant resolution and passes it in.
     */
    linearOrganizationId: string;
  },
): Promise<DispatchResult> {
  const { workflow, trigger, event, linearOrganizationId } = args;

  if (trigger.action !== "start_session") {
    return { outcome: "no_handler", error: `action_${trigger.action}` };
  }

  const orgId = workflow.organization_id ?? event.organization_id;
  if (!orgId) {
    return { outcome: "error", error: "missing_org_id" };
  }

  const teamId = event.team_id ?? event.issue?.team_id ?? null;
  if (!teamId) {
    return { outcome: "error", error: "missing_team_id" };
  }

  const project = await new ProjectStore(env.DB).getByTeamId(orgId, teamId);
  if (!project?.repo_url) {
    return { outcome: "error", error: "no_project_for_team" };
  }

  const issue = event.issue;
  if (!issue) {
    return { outcome: "error", error: "missing_issue" };
  }

  // Render the workflow's Liquid prompt template once on the dispatch
  // side. The rendered string flows into the synthesized webhook as
  // `promptContext`, which the SessionRunner picks up verbatim via
  // `resolvePrompt`.
  let prompt: string;
  try {
    prompt = await renderPrompt(workflow.prompt_template, {
      issue,
      attempt: 1,
      // `prompt_context` is what the template renders for the "Issue
      // body:" section. Without this the template's `{{ prompt_context }}`
      // placeholder evaluates to an empty string and pi is left
      // hallucinating the issue body from the title alone.
      prompt_context: issue.description ?? "",
      extra: {
        to_state:
          event.event_type === "state_entered" ? event.to_state : null,
        from_state:
          event.event_type === "state_entered"
            ? event.from_state ?? null
            : null,
        event_type: event.event_type,
      },
    });
  } catch (e) {
    return {
      outcome: "error",
      error: `render_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Resolve a fresh install access token. Linear tokens expire ~24h —
  // migration 0006 added `expires_at` so we only refresh when the
  // stored expiry is inside the run-timeout window. The refresh closure
  // injected into `createAgentSessionOnIssue` below handles the
  // mid-call expiry edge case too (e.g. row was fresh at load time but
  // expired before this mutation ran).
  const installs = new LinearAgentInstallStore(env.DB);
  const install = await installs.getByOrgId(orgId);
  if (!install) {
    return { outcome: "error", error: "no_install" };
  }
  const refreshed = await refreshInstallTokenIfNeeded(
    env,
    orgId,
    DISPATCH_RUN_TIMEOUT_MS,
  );
  let accessToken = refreshed?.accessToken ?? install.access_token;
  const refreshLinearToken = async () => {
    const r = await refreshInstallToken(env, orgId);
    if (r) accessToken = r.accessToken;
    return r?.accessToken ?? null;
  };

  // Mint a Linear-side AgentSession on the issue. Returns a UUID that
  // we use both as the SESSION_RUNNER workflow instance id (so Linear
  // retries collide on the same instance) and as the
  // `agent_sessions.id` primary key (so the dashboard's session
  // detail page lines up with the Linear session URL).
  let linearSessionId: string;
  try {
    const result = await createAgentSessionOnIssue(
      accessToken,
      issue.id,
      refreshLinearToken,
    );
    if (!result.success || !result.sessionId) {
      return {
        outcome: "error",
        error: "agent_session_create_failed",
      };
    }
    linearSessionId = result.sessionId;
  } catch (e) {
    return {
      outcome: "error",
      error: `agent_session_create_threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Build the synthetic webhook envelope. The SessionRunner reads
  // `agentSession.id` (instance id), `agentSession.issue.*` (repo
  // lookup + transition target), and `promptContext` (verbatim prompt
  // for the engine). `action: "created"` triggers the standard
  // post-initial-thought + transition-to-In-Progress flow.
  const syntheticEvent: AgentSessionEventWebhook = {
    type: "AgentSessionEvent",
    action: "created",
    webhookId: `trigger-${trigger.id}-${linearSessionId}`,
    organizationId: linearOrganizationId,
    agentSession: {
      id: linearSessionId,
      issue: {
        id: issue.id,
        identifier: issue.identifier ?? issue.id,
        title: issue.title ?? "",
        teamId: issue.team_id ?? teamId,
      },
      promptContext: prompt,
    },
    promptContext: prompt,
  };

  // Snapshot the resolved workflow's engine/model/max_turns onto the
  // params so the runner uses them instead of the org-level setting
  // fallback. workflows.engine and .max_turns are NOT NULL in the
  // schema (always have a value). workflows.model is nullable, and
  // NULL means "inherit from org default" — in that case we omit
  // the field so the runner falls through to settings/env. Only
  // string values are real overrides.
  const workflowOverrides: {
    engine: string;
    model?: string;
    max_turns: number;
  } = {
    engine: workflow.engine,
    max_turns: workflow.max_turns,
  };
  if (workflow.model !== null && workflow.model !== "") {
    workflowOverrides.model = workflow.model;
  }

  try {
    await env.SESSION_RUNNER.create({
      id: linearSessionId,
      params: {
        mode: "agent_session",
        event: syntheticEvent,
        workflow_overrides: workflowOverrides,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/instance.*exists|already/i.test(msg)) {
      // Idempotent — Linear retried the webhook. First call won.
      return { outcome: "start_session", agentSessionId: linearSessionId };
    }
    return { outcome: "error", error: `runner_create_failed: ${msg}` };
  }

  return { outcome: "start_session", agentSessionId: linearSessionId };
}
