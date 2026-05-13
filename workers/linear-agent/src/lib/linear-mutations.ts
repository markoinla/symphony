/**
 * Linear GraphQL mutation wrappers for non-activity writes — issue
 * updates (status / delegate), workflow-state lookup, and agent session
 * metadata (externalUrls, plan).
 *
 * Mirrors the bearer-auth + 401-refresh + `{ data, errors }` envelope
 * pattern from `activities.ts:buildActivityClient`. Direct fetch + raw
 * GraphQL (rather than `@linear/sdk`) for the same Workers-runtime
 * reasons documented there: the SDK's bundled fetch binding triggers
 * "Illegal invocation" inside the isolate.
 *
 * Field shapes come from:
 *   https://linear.app/developers/agent-best-practices
 *   https://linear.app/developers/agent-signals
 */

import { linearGraphQL, type LinearTokenRefresher } from "./linear-graphql";

// Workflow state lookup — finds the team's primary `started` state.
const WORKFLOW_STATES_QUERY = `
  query WorkflowStates($teamId: ID!) {
    workflowStates(
      filter: { team: { id: { eq: $teamId } }, type: { eq: "started" } }
    ) {
      nodes {
        id
        name
        position
        type
      }
    }
  }
`;

const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
    }
  }
`;

const AGENT_SESSION_UPDATE_MUTATION = `
  mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
    agentSessionUpdate(id: $id, input: $input) {
      success
    }
  }
`;

export interface UpdateIssueInput {
  issueId: string;
  stateId?: string;
  delegateId?: string;
}

export interface AgentSessionPlanItem {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface AgentSessionExternalUrl {
  label: string;
  url: string;
}

export interface UpdateAgentSessionInput {
  agentSessionId: string;
  externalUrls?: AgentSessionExternalUrl[];
  plan?: AgentSessionPlanItem[];
}

export interface WorkflowStateRef {
  id: string;
  name: string;
}

// Update an issue's state and/or delegate. Used to reflect the agent
// taking ownership of an issue when a session starts.
export async function updateIssue(
  token: string,
  input: UpdateIssueInput,
  onTokenExpired?: LinearTokenRefresher,
): Promise<{ success: boolean }> {
  const variablesInput: Record<string, string> = {};
  if (input.stateId !== undefined) variablesInput.stateId = input.stateId;
  if (input.delegateId !== undefined)
    variablesInput.delegateId = input.delegateId;

  const data = await linearGraphQL<{ issueUpdate?: { success?: boolean } }>({
    accessToken: token,
    query: ISSUE_UPDATE_MUTATION,
    variables: { id: input.issueId, input: variablesInput },
    opName: "issueUpdate",
    onTokenExpired,
  });
  return { success: data.issueUpdate?.success ?? false };
}

// Resolve the team's `started` workflow state with the lowest position
// — Linear treats this as the canonical "we're working on it" status.
export async function fetchTeamStartedState(
  token: string,
  teamId: string,
  onTokenExpired?: LinearTokenRefresher,
): Promise<WorkflowStateRef | null> {
  const data = await linearGraphQL<{
    workflowStates?: {
      nodes?: Array<{
        id: string;
        name: string;
        position: number;
        type: string;
      }>;
    };
  }>({
    accessToken: token,
    query: WORKFLOW_STATES_QUERY,
    variables: { teamId },
    opName: "workflowStates",
    onTokenExpired,
  });

  const nodes = data.workflowStates?.nodes ?? [];
  if (nodes.length === 0) return null;
  const lowest = nodes.reduce((acc, node) =>
    node.position < acc.position ? node : acc,
  );
  return { id: lowest.id, name: lowest.name };
}

// Update agent session metadata — currently `externalUrls` (header
// links) and `plan` (checklist). Linear renders both inside the session
// timeline UI. No-op `input` (neither field present) still succeeds.
export async function updateAgentSession(
  token: string,
  input: UpdateAgentSessionInput,
  onTokenExpired?: LinearTokenRefresher,
): Promise<{ success: boolean }> {
  const variablesInput: Record<string, unknown> = {};
  if (input.externalUrls !== undefined)
    variablesInput.externalUrls = input.externalUrls;
  if (input.plan !== undefined) variablesInput.plan = input.plan;

  const data = await linearGraphQL<{ agentSessionUpdate?: { success?: boolean } }>({
    accessToken: token,
    query: AGENT_SESSION_UPDATE_MUTATION,
    variables: { id: input.agentSessionId, input: variablesInput },
    opName: "agentSessionUpdate",
    onTokenExpired,
  });
  return { success: data.agentSessionUpdate?.success ?? false };
}
