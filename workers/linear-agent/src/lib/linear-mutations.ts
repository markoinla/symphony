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

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

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

type TokenRefresher = () => Promise<string | null>;

// Update an issue's state and/or delegate. Used to reflect the agent
// taking ownership of an issue when a session starts.
export async function updateIssue(
  token: string,
  input: UpdateIssueInput,
  onTokenExpired?: TokenRefresher,
): Promise<{ success: boolean }> {
  const variablesInput: Record<string, string> = {};
  if (input.stateId !== undefined) variablesInput.stateId = input.stateId;
  if (input.delegateId !== undefined)
    variablesInput.delegateId = input.delegateId;

  const body = JSON.stringify({
    query: ISSUE_UPDATE_MUTATION,
    variables: { id: input.issueId, input: variablesInput },
  });

  const json = await postGraphQL<{ issueUpdate?: { success?: boolean } }>(
    token,
    body,
    "issueUpdate",
    onTokenExpired,
  );
  return { success: json.issueUpdate?.success ?? false };
}

// Resolve the team's `started` workflow state with the lowest position
// — Linear treats this as the canonical "we're working on it" status.
export async function fetchTeamStartedState(
  token: string,
  teamId: string,
  onTokenExpired?: TokenRefresher,
): Promise<WorkflowStateRef | null> {
  const body = JSON.stringify({
    query: WORKFLOW_STATES_QUERY,
    variables: { teamId },
  });

  const json = await postGraphQL<{
    workflowStates?: {
      nodes?: Array<{
        id: string;
        name: string;
        position: number;
        type: string;
      }>;
    };
  }>(token, body, "workflowStates", onTokenExpired);

  const nodes = json.workflowStates?.nodes ?? [];
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
  onTokenExpired?: TokenRefresher,
): Promise<{ success: boolean }> {
  const variablesInput: Record<string, unknown> = {};
  if (input.externalUrls !== undefined)
    variablesInput.externalUrls = input.externalUrls;
  if (input.plan !== undefined) variablesInput.plan = input.plan;

  const body = JSON.stringify({
    query: AGENT_SESSION_UPDATE_MUTATION,
    variables: { id: input.agentSessionId, input: variablesInput },
  });

  const json = await postGraphQL<{ agentSessionUpdate?: { success?: boolean } }>(
    token,
    body,
    "agentSessionUpdate",
    onTokenExpired,
  );
  return { success: json.agentSessionUpdate?.success ?? false };
}

// Shared bearer-auth POST with 401-refresh + `{ data, errors }` envelope
// handling. The `opName` is prefixed onto both HTTP and GraphQL errors
// so callers can grep for the operation that failed.
async function postGraphQL<T>(
  initialToken: string,
  body: string,
  opName: string,
  onTokenExpired: TokenRefresher | undefined,
): Promise<T> {
  let token = initialToken;
  let res = await postWithToken(token, body);
  if (res.status === 401 && onTokenExpired) {
    const refreshed = await onTokenExpired();
    if (refreshed) {
      token = refreshed;
      res = await postWithToken(token, body);
    }
  }
  if (!res.ok) {
    throw new Error(
      `${opName} http ${res.status}: ${(await res.text()).slice(0, 500)}`,
    );
  }
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `${opName} graphql: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return (json.data ?? ({} as T)) as T;
}

async function postWithToken(token: string, body: string): Promise<Response> {
  return fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    },
    body,
  });
}
