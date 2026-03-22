---
name: linear
description: |
  Interact with Linear for issue queries, comment management, state transitions,
  and PR attachments. Use the Linear MCP tools or gh CLI for operations.
---

# Linear

Use this skill for Linear operations: querying issues, managing comments,
transitioning states, and attaching PRs.

## Available Tools

Linear MCP tools may be deferred — if they are not immediately visible, use
`ToolSearch` to discover and load them before use. Do NOT conclude that MCP tools
are unavailable without searching first.

Use the available Linear MCP tools for common operations:

- `get_issue` / `list_issues` — query issues
- `save_issue` — create or update issues
- `save_comment` / `list_comments` / `delete_comment` — manage comments
- `list_issue_statuses` / `get_issue_status` — workflow states
- `get_project` / `list_projects` — project queries
- `get_team` / `list_teams` — team queries
- `create_attachment` / `get_attachment` / `delete_attachment` — attachments
- `create_issue_label` / `list_issue_labels` — labels
- `search_documentation` — search Linear docs

## Common Workflows

### Query an issue by key

Use `get_issue` with the issue identifier (e.g., `MT-686`).

### Move an issue to a different state

1. Use `list_issue_statuses` to find available states for the team.
2. Use `save_issue` with the new `stateId`.

### Create a comment on an issue

Use `save_comment` with the issue ID and comment body.

### Attach a GitHub PR to an issue

Use `create_attachment` with the PR URL and issue ID.

## GraphQL Reference

For operations not covered by MCP tools, you can use `gh api graphql` with the
Linear API. Common patterns:

### Query an issue by key

```graphql
query IssueByKey($key: String!) {
  issue(id: $key) {
    id
    identifier
    title
    state { id name type }
    project { id name }
    branchName
    url
    description
  }
}
```

### Query team workflow states

```graphql
query IssueTeamStates($id: String!) {
  issue(id: $id) {
    id
    team {
      id
      key
      name
      states { nodes { id name type } }
    }
  }
}
```

### Edit a comment

```graphql
mutation UpdateComment($id: String!, $body: String!) {
  commentUpdate(id: $id, input: { body: $body }) {
    success
    comment { id body }
  }
}
```

### Create a comment

```graphql
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id url }
  }
}
```

### Move an issue to a state

```graphql
mutation MoveIssueToState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { id identifier state { id name } }
  }
}
```

### Attach a GitHub PR

```graphql
mutation AttachGitHubPR($issueId: String!, $url: String!, $title: String) {
  attachmentLinkGitHubPR(
    issueId: $issueId
    url: $url
    title: $title
    linkKind: links
  ) {
    success
    attachment { id title url }
  }
}
```

## Usage Rules

- Prefer MCP tools for standard operations; fall back to GraphQL for advanced
  or unsupported operations.
- Prefer the narrowest issue lookup that matches what you already know:
  key -> identifier search -> internal id.
- For state transitions, fetch team states first and use the exact `stateId`
  instead of hardcoding names.
- Prefer `attachmentLinkGitHubPR` over a generic URL attachment when linking a
  GitHub PR to a Linear issue.
