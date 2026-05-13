/**
 * Linear issue state transitions for the linear-agent worker.
 *
 * Port of `Linear.Client.update_issue_state/2` and `resolve_state_id`
 * from `lib/symphony_elixir/linear/client.ex`. The state machine
 * encoded in `WORKFLOW.md` Step 0:
 *
 *   Backlog       → (untouched; humans decide when to start)
 *   Todo          → In Progress (on dispatch kickoff)
 *   In Progress   → Human Review (on successful PR creation)
 *   Human Review  → Merging (humans do this, agent doesn't touch)
 *   Merging       → Done (handled by the land skill, not here)
 *   Rework        → In Progress on next dispatch
 *
 * `transitionIssue` is idempotent: if the issue is already in the
 * target state, it no-ops. State name lookup is two-step (resolve
 * the team-specific state UUID, then update) — Linear's API doesn't
 * accept state names directly.
 */

import { linearGraphQL, type LinearTokenRefresher } from "./linear-graphql";

export interface IssueSnapshot {
  id: string;
  identifier: string;
  state: { name: string };
}

const GET_ISSUE_STATE_QUERY = `
  query GetIssueState($id: String!) {
    issue(id: $id) {
      id
      identifier
      state { name }
    }
  }
`;

const RESOLVE_STATE_ID_QUERY = `
  query ResolveStateId($issueId: String!, $stateName: String!) {
    issue(id: $issueId) {
      team {
        states(filter: {name: {eq: $stateName}}, first: 1) {
          nodes { id }
        }
      }
    }
  }
`;

const UPDATE_ISSUE_STATE_MUTATION = `
  mutation UpdateIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: {stateId: $stateId}) {
      success
    }
  }
`;

export async function getIssueState(
  accessToken: string,
  issueId: string,
  onTokenExpired?: LinearTokenRefresher,
): Promise<IssueSnapshot | null> {
  const json = await linearGraphQL<{
    issue?: { id: string; identifier: string; state: { name: string } } | null;
  }>({
    accessToken,
    query: GET_ISSUE_STATE_QUERY,
    variables: { id: issueId },
    opName: "linear_graphql.getIssueState",
    onTokenExpired,
  });
  if (!json.issue) return null;
  return {
    id: json.issue.id,
    identifier: json.issue.identifier,
    state: { name: json.issue.state.name },
  };
}

/**
 * Move the issue to `targetStateName`. Returns the previous state
 * name (useful for logs / activity timeline) or null if the issue
 * was already in the target state.
 *
 * No-ops on:
 *   - issue not found
 *   - target state not configured on the team (logged + null returned)
 *   - issue already in the target state
 */
export async function transitionIssue(
  accessToken: string,
  issueId: string,
  targetStateName: string,
  onTokenExpired?: LinearTokenRefresher,
): Promise<{ from: string; to: string } | null> {
  const snapshot = await getIssueState(accessToken, issueId, onTokenExpired);
  if (!snapshot) return null;
  if (snapshot.state.name === targetStateName) return null;

  const resolved = await linearGraphQL<{
    issue?: {
      team?: { states?: { nodes?: Array<{ id: string }> } };
    } | null;
  }>({
    accessToken,
    query: RESOLVE_STATE_ID_QUERY,
    variables: { issueId, stateName: targetStateName },
    opName: "linear_graphql.resolveStateId",
    onTokenExpired,
  });
  const stateId = resolved.issue?.team?.states?.nodes?.[0]?.id;
  if (!stateId) {
    console.error(
      "transition_state_unknown",
      JSON.stringify({
        issue_id: issueId,
        identifier: snapshot.identifier,
        target_state: targetStateName,
      }),
    );
    return null;
  }

  const updated = await linearGraphQL<{
    issueUpdate?: { success?: boolean };
  }>({
    accessToken,
    query: UPDATE_ISSUE_STATE_MUTATION,
    variables: { issueId, stateId },
    opName: "linear_graphql.updateIssueState",
    onTokenExpired,
  });
  if (!updated.issueUpdate?.success) {
    throw new Error(
      `transition_failed: ${snapshot.identifier} ${snapshot.state.name} → ${targetStateName}`,
    );
  }
  return { from: snapshot.state.name, to: targetStateName };
}
