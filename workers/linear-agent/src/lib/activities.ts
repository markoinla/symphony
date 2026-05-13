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

import { linearGraphQL, type LinearTokenRefresher } from "./linear-graphql";
import type { AgentActivityContent } from "../types/agent-session";

export interface ActivityClient {
  createAgentActivity(input: {
    agentSessionId: string;
    content: AgentActivityContent;
  }): Promise<{ success: boolean }>;
}

const AGENT_ACTIVITY_CREATE_MUTATION = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
    }
  }
`;

/**
 * Build an ActivityClient that posts directly via fetch + GraphQL.
 *
 * `accessToken` is the agent's `actor=app` install token. Linear's
 * tokens expire (typically ~24h); when the GraphQL endpoint returns
 * 401 we transparently call `onTokenExpired()` to fetch a fresh
 * token, then retry the request once. Mirrors the Elixir side's
 * `Linear.AgentAPI.handle_unauthorized` → `Refresher.force_refresh`
 * → retry pattern (`lib/symphony_elixir/linear/agent_api.ex:160`).
 *
 * Pass `onTokenExpired` to enable the reactive refresh path; callers
 * without a refresh source (tests, one-shot smoke checks) can omit
 * it and the client will throw on 401 like before.
 *
 * Latching: the client caches the most recent post-refresh token so
 * subsequent activities in the same stream skip the 401 round-trip.
 * That matters for the dispatcher-stream call site, which can post
 * dozens of activities per turn — we don't want each one to re-cycle
 * through 401-then-refresh after the first expiry has already been
 * observed.
 */
export function buildActivityClient(
  accessToken: string,
  onTokenExpired?: LinearTokenRefresher,
): ActivityClient {
  let currentToken = accessToken;
  return {
    async createAgentActivity(input) {
      const data = await linearGraphQL<{
        agentActivityCreate?: { success?: boolean };
      }>({
        accessToken: currentToken,
        query: AGENT_ACTIVITY_CREATE_MUTATION,
        variables: { input },
        opName: "agentActivityCreate",
        onTokenExpired: onTokenExpired
          ? async () => {
              const refreshed = await onTokenExpired();
              if (refreshed) currentToken = refreshed;
              return refreshed;
            }
          : undefined,
      });
      return { success: data.agentActivityCreate?.success ?? false };
    },
  };
}

export async function postThought(
  client: ActivityClient,
  agentSessionId: string,
  body: string,
  opts?: { ephemeral?: boolean },
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId,
    content: {
      type: "thought",
      body,
      ...(opts?.ephemeral !== undefined ? { ephemeral: opts.ephemeral } : {}),
    },
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
  opts?: { ephemeral?: boolean },
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId,
    content: {
      type: "action",
      action,
      parameter,
      ...(result !== undefined ? { result } : {}),
      ...(opts?.ephemeral !== undefined ? { ephemeral: opts.ephemeral } : {}),
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
 * Mint a Linear AgentSession attached to an issue. Used by the
 * trigger dispatch path (SYM-295) to create a Linear-side session
 * when the workflow is initiated by a state transition rather than a
 * user @-mention — so the agent's activities render in the issue's
 * timeline the same way they do for mention-initiated runs.
 *
 * Mirrors `SymphonyElixir.Linear.AgentAPI.create_session_on_issue`
 * (lib/symphony_elixir/linear/agent_api.ex:42-65). Linear's input
 * type is `AgentSessionCreateOnIssue`; only `issueId` is required.
 */
const AGENT_SESSION_CREATE_ON_ISSUE_MUTATION = `
  mutation SymphonyCreateAgentSession($input: AgentSessionCreateOnIssue!) {
    agentSessionCreateOnIssue(input: $input) {
      success
      agentSession {
        id
      }
    }
  }
`;

export async function createAgentSessionOnIssue(
  accessToken: string,
  issueId: string,
  onTokenExpired?: LinearTokenRefresher,
): Promise<{ success: boolean; sessionId: string | null }> {
  const data = await linearGraphQL<{
    agentSessionCreateOnIssue?: {
      success?: boolean;
      agentSession?: { id?: string };
    };
  }>({
    accessToken,
    query: AGENT_SESSION_CREATE_ON_ISSUE_MUTATION,
    variables: { input: { issueId } },
    opName: "agentSessionCreateOnIssue",
    onTokenExpired,
  });
  return {
    success: data.agentSessionCreateOnIssue?.success ?? false,
    sessionId: data.agentSessionCreateOnIssue?.agentSession?.id ?? null,
  };
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
  onTokenExpired?: LinearTokenRefresher,
): Promise<{ success: boolean; attachmentId: string | null }> {
  const data = await linearGraphQL<{
    attachmentCreate?: {
      success?: boolean;
      attachment?: { id?: string };
    };
  }>({
    accessToken,
    query: ATTACHMENT_CREATE_MUTATION,
    variables: {
      input: {
        issueId: args.issueId,
        url: args.url,
        title: args.title,
        ...(args.subtitle ? { subtitle: args.subtitle } : {}),
      },
    },
    opName: "attachmentCreate",
    onTokenExpired,
  });
  return {
    success: data.attachmentCreate?.success ?? false,
    attachmentId: data.attachmentCreate?.attachment?.id ?? null,
  };
}
