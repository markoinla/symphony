/**
 * Linear Agent Session webhook payload shapes.
 *
 * The Agent Session API is the newer interaction model (replacing the
 * older `AppUserNotification` flow shown in linear/linear-agent-demo).
 * Sessions are created when a user delegates an issue to or @-mentions
 * an `actor=app` install. Each session has a lifecycle the agent drives
 * by posting `AgentActivity` records (thought / action / response /
 * elicitation / error).
 *
 * SLA reminders the receiver must honor:
 *   - ack the webhook (HTTP 2xx) within 5 seconds
 *   - emit a first activity (typically `thought`) within 10 seconds
 *
 * See: https://linear.app/developers/agents
 *      https://linear.app/developers/agent-interaction
 */

export type AgentSessionAction = "created" | "prompted";

export interface AgentSessionEventWebhook {
  type: "AgentSessionEvent";
  action: AgentSessionAction;
  // Linear stamps each delivery with a unique id; the receiver should
  // dedupe on this when retries arrive.
  webhookId: string;
  // The org this delivery is for. Empty in early Linear API versions but
  // supplied for newer ones — we keep it optional and don't depend on it.
  organizationId?: string;
  appUserId?: string;
  agentSession: AgentSession;
}

export interface AgentSession {
  id: string;
  issue?: AgentSessionIssue;
  comment?: AgentSessionComment;
  // Pre-rendered prompt the user effectively asked the agent — title,
  // description, comment thread, formatted as markdown. Use this verbatim
  // as the agent prompt rather than re-fetching the issue.
  promptContext?: string;
}

export interface AgentSessionIssue {
  id: string;
  identifier: string; // e.g. "SYM-162"
  title: string;
  teamId?: string;
  team?: { id: string; key?: string };
}

export interface AgentSessionComment {
  id: string;
  body: string;
  userId?: string;
}

export type AgentActivityType =
  | "thought"
  | "action"
  | "response"
  | "elicitation"
  | "error";

export interface AgentActivityContent {
  type: AgentActivityType;
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}
