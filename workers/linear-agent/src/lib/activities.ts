/**
 * Thin wrappers around `linearClient.createAgentActivity` for each of the
 * five activity types Linear exposes on an Agent Session.
 *
 * Activities are how the agent communicates progress back to the user
 * inside the Linear UI — Linear's session timeline renders them in order.
 *
 * The shape of each `content` payload comes from the Agent Interaction
 * SDK docs (https://linear.app/developers/agent-interaction).
 */

import type { AgentActivityContent } from "../types/agent-session";

// We intentionally do NOT import LinearClient as a hard type — keeping
// this surface minimal (just the one method we call) makes it easy to
// pass a fake in tests without dragging in the whole SDK.
export interface ActivityClient {
  createAgentActivity(input: {
    agentSessionId: string;
    content: AgentActivityContent;
  }): Promise<{ success: boolean }>;
}

export async function postThought(
  client: ActivityClient,
  agentSessionId: string,
  body: string,
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId,
    content: { type: "thought", body },
  });
}

export async function postResponse(
  client: ActivityClient,
  agentSessionId: string,
  body: string,
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId,
    content: { type: "response", body },
  });
}

export async function postError(
  client: ActivityClient,
  agentSessionId: string,
  body: string,
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId,
    content: { type: "error", body },
  });
}

export async function postAction(
  client: ActivityClient,
  agentSessionId: string,
  action: string,
  parameter: string,
  result?: string,
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId,
    content: {
      type: "action",
      action,
      parameter,
      ...(result !== undefined ? { result } : {}),
    },
  });
}

export async function postElicitation(
  client: ActivityClient,
  agentSessionId: string,
  body: string,
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId,
    content: { type: "elicitation", body },
  });
}
