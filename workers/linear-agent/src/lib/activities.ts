/**
 * Thin wrappers around the Linear `agentActivityCreate` GraphQL mutation
 * for each of the five activity types Linear exposes on an Agent Session.
 *
 * Activities are how the agent communicates progress back to the user
 * inside the Linear UI — Linear's session timeline renders them in order.
 *
 * Implementation note: we POST GraphQL directly rather than going
 * through `@linear/sdk`'s `linearClient.createAgentActivity(...)`. The
 * SDK's compiled bundle calls fetch in a way that triggers Workers'
 * "Illegal invocation: function called with incorrect this reference"
 * error. A direct fetch with a stable closure avoids that entirely and
 * doesn't require pinning to a specific SDK version.
 *
 * The shape of each `content` payload comes from the Agent Interaction
 * SDK docs (https://linear.app/developers/agent-interaction).
 */

import type { AgentActivityContent } from "../types/agent-session";

export interface ActivityClient {
  createAgentActivity(input: {
    agentSessionId: string;
    content: AgentActivityContent;
  }): Promise<{ success: boolean }>;
}

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const AGENT_ACTIVITY_CREATE_MUTATION = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
    }
  }
`;

/**
 * Build an ActivityClient that posts directly via fetch + GraphQL.
 * `accessToken` is the agent's `actor=app` install token from KV.
 */
export function buildActivityClient(accessToken: string): ActivityClient {
  return {
    async createAgentActivity(input) {
      const res = await fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: accessToken.startsWith("Bearer ")
            ? accessToken
            : `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          query: AGENT_ACTIVITY_CREATE_MUTATION,
          variables: { input },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `agentActivityCreate http ${res.status}: ${(await res.text()).slice(0, 500)}`,
        );
      }
      const json = (await res.json()) as {
        data?: { agentActivityCreate?: { success?: boolean } };
        errors?: Array<{ message: string }>;
      };
      if (json.errors && json.errors.length > 0) {
        throw new Error(
          `agentActivityCreate graphql: ${json.errors.map((e) => e.message).join("; ")}`,
        );
      }
      return { success: json.data?.agentActivityCreate?.success ?? false };
    },
  };
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

/**
 * Create an attachment on a Linear issue. Used by item 4 to surface
 * the GitHub PR back in the issue's right-rail. Mirrors
 * `Linear.Client.create_attachment` in
 * `lib/symphony_elixir/linear/client.ex`.
 */
const ATTACHMENT_CREATE_MUTATION = `
  mutation AttachmentCreate($input: AttachmentCreateInput!) {
    attachmentCreate(input: $input) {
      success
      attachment { id url }
    }
  }
`;

export async function createAttachment(
  accessToken: string,
  args: {
    issueId: string;
    url: string;
    title: string;
    subtitle?: string;
  },
): Promise<{ success: boolean; attachmentId: string | null }> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: accessToken.startsWith("Bearer ")
        ? accessToken
        : `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: ATTACHMENT_CREATE_MUTATION,
      variables: {
        input: {
          issueId: args.issueId,
          url: args.url,
          title: args.title,
          ...(args.subtitle ? { subtitle: args.subtitle } : {}),
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `attachmentCreate http ${res.status}: ${(await res.text()).slice(0, 500)}`,
    );
  }
  const json = (await res.json()) as {
    data?: {
      attachmentCreate?: {
        success?: boolean;
        attachment?: { id?: string };
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `attachmentCreate graphql: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return {
    success: json.data?.attachmentCreate?.success ?? false,
    attachmentId: json.data?.attachmentCreate?.attachment?.id ?? null,
  };
}
