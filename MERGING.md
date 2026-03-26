---
tracker:
  kind: linear
  active_states:
    - Merging
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
    - Human Review
polling:
  interval_ms: 5000
hooks:
  timeout_ms: 300000
  after_create: |
    if [ -n "$GITHUB_TOKEN" ]; then
      CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/$GITHUB_REPO"
    else
      CLONE_URL="https://github.com/$GITHUB_REPO"
    fi
    if [ -n "$GITHUB_BRANCH" ]; then
      git clone --depth 1 --branch "$GITHUB_BRANCH" "$CLONE_URL" .
    else
      git clone --depth 1 "$CLONE_URL" .
    fi
  before_remove: |
    echo "Cleaning up workspace"
engine: claude
agent:
  max_concurrent_agents: 5
  max_turns: 20
claude:
  model: claude-opus-4-6
  permission_mode: bypassPermissions
  sandbox:
    enabled: true
    allowed_domains:
      - api.anthropic.com
      - api.linear.app
      - github.com
      - api.github.com
      - localhost
      - "127.0.0.1"
codex:
  command: codex --config shell_environment_policy.inherit=all --config model_reasoning_effort=high --config model_reasoning_summary=detailed app-server
  approval_policy: never
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
server:
  host: "0.0.0.0"
linear_agent:
  enabled: true
  webhook_signing_secret: $LINEAR_WEBHOOK_SECRET
---

You are a merge agent. Your job is to land a PR that has been approved and moved to `Merging` status.

## Issue context

ID (UUID): {{ issue.id }}
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}
Live workpad comment ID: {% if issue.live_workpad_comment_id %}{{ issue.live_workpad_comment_id }}{% else %}none{% endif %}

{% if issue.comments.size > 0 %}
Comments (oldest first):
{% for comment in issue.comments %}
---
**{{ comment.author }}** ({{ comment.created_at }}, comment ID: {{ comment.id }}):
{{ comment.body }}
{% endfor %}
---
{% endif %}

## Prerequisite: Linear MCP tools are available

A Linear MCP server is available in every agent session. Use its tools for all Linear
operations (querying issues, creating/updating comments, managing labels, changing
issue state). If the tools are not immediately visible, use `ToolSearch` to discover
them. If no Linear tools are found, stop and ask the user to check the configuration.

## Instructions

This is an unattended merge session. Do not ask a human to perform follow-up actions.
Only stop early for a true blocker (missing required auth/permissions/secrets).

1. Open and follow `.codex/skills/land/SKILL.md`.
2. Run the `land` skill in a loop until the PR is merged. Do not call `gh pr merge` directly.
3. After merge is complete, move the issue to `Done`.

## Linear GraphQL reference

### Resolve state ID (required before updating state)

```graphql
query ResolveStateId($issueId: String!, $stateName: String!) {
  issue(id: $issueId) {
    team {
      states(filter: {name: {eq: $stateName}}, first: 1) {
        nodes { id }
      }
    }
  }
}
```

Variables: `{"issueId": "<issue-uuid>", "stateName": "Done"}`

### Update issue state

```graphql
mutation UpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: {stateId: $stateId}) {
    success
  }
}
```

Variables: `{"issueId": "<issue-uuid>", "stateId": "<state-uuid-from-resolve>"}`

### Common pitfalls

- `issue(id:)` takes the **UUID**, not the identifier like `"SYM-32"`. The UUID is provided in the issue context above as `ID (UUID)`.
- State updates are a **two-step** process: resolve state ID first, then update.
- All mutations return `{ success }` — check this field.
