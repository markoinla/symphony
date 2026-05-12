/**
 * Linear GraphQL cheatsheet appended to every prompt sent to the engine.
 *
 * We used to attach Linear's hosted MCP server (https://mcp.linear.app/sse)
 * via `credentials.mcp_servers` so Pi could call typed Linear tools. That
 * coupled every run to MCP cold-starts and hosted-MCP availability and
 * only worked for engines with MCP wiring.
 *
 * The new contract is engine-agnostic: the dispatcher injects
 * `LINEAR_API_TOKEN` into the sandbox env (see `linear_token` in
 * `workers/sandbox-dispatcher/src/run.ts`) and the engine uses `curl`
 * against Linear's GraphQL endpoint. This constant is appended verbatim
 * to the rendered prompt so the engine always has the endpoint, auth
 * header, and the queries/mutations it needs without each
 * workflow's `prompt_template` having to spell them out.
 *
 * Mirrors the reference block in `WORKFLOW.md`; keep them in sync when
 * Linear's schema changes.
 */

export const LINEAR_GRAPHQL_REFERENCE = `

---

## Linear access (use raw GraphQL — no MCP)

The Linear MCP is not attached. Use Linear's HTTP GraphQL API directly. A
per-session bearer token is in the env var \`LINEAR_API_TOKEN\` — never
echo it, log it, or commit it.

\`\`\`bash
curl -sS https://api.linear.app/graphql \\
  -H "Authorization: Bearer $LINEAR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "...", "variables": {...}}'
\`\`\`

All ID parameters are opaque UUIDs (not human-readable identifiers like
\`SYM-32\`). The issue UUID is provided in the issue context above as
\`ID (UUID)\`.

### Fetch issue by ID

\`\`\`graphql
query GetIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    priority
    state { name }
    branchName
    url
    assignee { id name }
    labels { nodes { name } }
    comments(first: 50) {
      nodes { id body user { id name } createdAt }
    }
    createdAt
    updatedAt
  }
}
\`\`\`

### Resolve state ID (required before updating state)

\`\`\`graphql
query ResolveStateId($issueId: String!, $stateName: String!) {
  issue(id: $issueId) {
    team {
      states(filter: {name: {eq: $stateName}}, first: 1) {
        nodes { id }
      }
    }
  }
}
\`\`\`

Extract: \`data.issue.team.states.nodes[0].id\`.

### Update issue state (two-step: resolve, then update)

\`\`\`graphql
mutation UpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: {stateId: $stateId}) { success }
}
\`\`\`

### Create comment

\`\`\`graphql
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: {issueId: $issueId, body: $body}) {
    success
    comment { id }
  }
}
\`\`\`

Save the returned \`comment.id\` so you can update the same comment
later (use it as the single \`## Codex Workpad\` comment).

### Update comment (edit workpad in place)

\`\`\`graphql
mutation UpdateComment($commentId: String!, $body: String!) {
  commentUpdate(id: $commentId, input: {body: $body}) { success }
}
\`\`\`

\`commentUpdate\` takes the **comment ID**, not the issue ID.

### Create issue / link follow-ups

\`\`\`graphql
mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $projectId: String) {
  issueCreate(input: {teamId: $teamId, title: $title, description: $description, projectId: $projectId}) {
    success
    issue { id identifier url }
  }
}

mutation CreateRelation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
  issueRelationCreate(input: {issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type}) {
    success
  }
}
\`\`\`

\`IssueRelationType\` is an enum (\`blocks\`, \`related\`, \`duplicate\`,
\`similar\`) — pass it as an enum, not a quoted string.

### Attach PR to issue

\`\`\`graphql
mutation CreateAttachment($issueId: String!, $url: String!, $title: String!) {
  attachmentCreate(input: {issueId: $issueId, url: $url, title: $title}) { success }
}
\`\`\`

### Add label

\`\`\`graphql
query FindLabel($teamId: String!, $labelName: String!) {
  team(id: $teamId) {
    labels(filter: {name: {eq: $labelName}}, first: 1) { nodes { id name } }
  }
}

mutation AddLabel($issueId: String!, $labelIds: [String!]!) {
  issueUpdate(id: $issueId, input: {labelIds: $labelIds}) { success }
}
\`\`\`

### Common pitfalls

- \`issue(id:)\` takes the UUID, not the identifier (\`SYM-32\`).
- State updates are a two-step process: resolve state ID first, then
  update.
- \`commentUpdate\` takes the comment ID as its first argument, not the
  issue ID.
- All mutations return \`{ success }\` — always check it.
- On \`Unknown field\` errors you are guessing at field names. Stop and
  re-read this reference rather than retrying variations.
`;

/**
 * Append the Linear GraphQL reference to a prompt unless the prompt
 * already contains it (idempotent — safe to call from multiple call
 * sites, including continuation-prompt builders that embed the
 * original prompt).
 */
export function withLinearGraphqlReference(prompt: string): string {
  if (prompt.includes("## Linear access (use raw GraphQL")) {
    return prompt;
  }
  return prompt + LINEAR_GRAPHQL_REFERENCE;
}
