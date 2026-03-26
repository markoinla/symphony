# Agent Workflow

This document describes the end-to-end agent workflow in Symphony: how issues flow from Linear
into isolated workspaces, how agents execute, and how results are reported back.

## Pipeline Overview

The core pipeline flows through four components:

```
Orchestrator  →  AgentRunner  →  Workspace  →  Engine (Codex AppServer)
   (poll)         (execute)      (isolate)       (run turns)
```

1. **Orchestrator** polls Linear for candidate issues in active states.
2. **AgentRunner** claims an issue and creates an isolated workspace.
3. **Workspace** provisions a per-issue directory with repository hooks.
4. **Engine** (Codex AppServer) runs multi-turn agent sessions inside the workspace.

Results flow back through Linear: comments, state transitions, and PR attachments are managed by
the agent during execution, while session activities are streamed to the Linear Agent API.

## Components

### Orchestrator

`SymphonyElixir.Orchestrator` is a GenServer that continuously polls Linear and dispatches agent
runs with bounded concurrency.

**Responsibilities:**

- Poll Linear on a configurable interval (default 5 seconds) for issues in active states.
- Filter candidates by project slug or label name (configured in `WORKFLOW.md`).
- Claim issues atomically via the `IssueClaim` database table to prevent duplicate dispatch across
  orchestrator instances.
- Launch `AgentRunner` tasks up to `max_concurrent_agents`, with optional per-state concurrency
  limits (`max_concurrent_agents_by_state`).
- Track running sessions including token usage, turn counts, and PIDs.
- Handle retries with exponential backoff and cooldown periods.
- Release claims and clean up workspaces after agent completion.
- Accept webhook hints from Linear to expedite the next poll cycle.

**Triggering:** The orchestrator starts automatically when Symphony boots. It runs a `:tick`
handler on each polling interval, fetching candidates, filtering, claiming, and dispatching.

**Configuration (from `WORKFLOW.md`):**

| Key | Description | Default |
|-----|-------------|---------|
| `polling.interval_ms` | Poll interval in milliseconds | `5000` |
| `agent.max_concurrent_agents` | Maximum concurrent agent runs | `5` |
| `agent.max_turns` | Maximum turns per session | `20` |
| `agent.max_turn_retries` | Retries per failed turn | `3` |
| `tracker.active_states` | Issue states eligible for pickup | `[Todo, In Progress, Rework]` |
| `tracker.terminal_states` | Issue states that stop execution | `[Closed, Cancelled, Done, Human Review, Duplicate]` |
| `tracker.filter_by` | Filter mode: `"project"` or `"label"` | — |

### AgentRunner

`SymphonyElixir.AgentRunner` executes a single Linear issue end-to-end in an isolated workspace.

**Responsibilities:**

- Create a workspace for the issue via `Workspace.create_for_issue/2`.
- Run workspace hooks (`after_create` for git clone, `before_run` for setup).
- Build the initial prompt with full issue context (title, description, comments, labels).
- Execute multi-turn agent sessions via the configured engine.
- Handle turn retries with exponential backoff (5s base, 2x multiplier, 30s cap).
- Watch for new Linear comments between turns and include them in continuation prompts.
- Drain pending prompts injected mid-run via webhooks.
- Detect GitHub PR URLs in turn output and attach them to the issue.
- Sync the workpad plan to the Linear Agent session after each turn.
- Determine whether to continue based on issue state and turn limits.

**Turn lifecycle:**

1. Build prompt: first turn uses full issue context; continuation turns include new comments and
   guidance on resuming.
2. Run turn via engine with retry logic.
3. Emit activities to `AgentSession` for Linear streaming.
4. Check continuation conditions: issue still in active state, turn count under limit, label
   filter still matches.
5. If continuing: drain pending prompts, fetch fresh issue state, loop.
6. If done: finalize session with outcome.

**Turn retry:** Only retries `turn_failed` and `turn_cancelled` errors. Backoff is
`5s * 2^(attempt-1)`, capped at 30 seconds.

### AgentSession

`SymphonyElixir.AgentSession` is a GenServer that bridges engine events to the Linear Agent API.

**Responsibilities:**

- Map 1:1 to a Linear Agent session (created when the orchestrator dispatches an issue).
- Route engine events to Linear via `ActivityMapper` with throttling (minimum 500ms between API
  calls).
- Store and sync the hierarchical workpad plan to the Linear agent session.
- Queue mid-run user prompts from Linear webhooks for the next continuation turn.
- Track external URLs (PR links) and sync them to the session.

**Activity types emitted:**

| Engine event | Linear activity type |
|-------------|---------------------|
| `claude/thinking` | `thought` (ephemeral) |
| `claude/tool_use` | `action` |
| `claude/assistant_message` | `response` |
| `tool_call_completed` | `action` (tool_result) |
| `turn_completed` | `thought` |
| `turn_failed` | `error` |

### Workspace

`SymphonyElixir.Workspace` creates and manages isolated per-issue execution environments.

**Responsibilities:**

- Create a directory at `<workspace_root>/<safe_identifier>` for each issue.
- Validate paths to prevent symlink escape or directory traversal.
- Run configurable hooks at lifecycle points: `after_create`, `before_run`, `after_run`,
  `before_remove`.
- Support both local and remote (SSH) workspace creation.
- Clean up workspaces after agent completion.

**Hook environment variables:**

Hooks receive environment variables for repository context:

- `GITHUB_REPO` — repository from project settings.
- `GITHUB_BRANCH` — branch from project settings.
- `GITHUB_TOKEN` — OAuth token if available.
- Project-specific `env_vars` from settings.

**Hook timeout:** Default 300 seconds (configurable via `hooks.timeout_ms`).

**Safety constraints:** Workspace paths are canonicalized and validated to ensure they remain
under the configured root directory. Remote workspaces are validated for empty paths, null bytes,
and newlines.

### Codex AppServer

`SymphonyElixir.Codex.AppServer` is a JSON-RPC 2.0 client that manages Codex in app-server mode.

**Responsibilities:**

- Spawn Codex as a subprocess via Port (local) or SSH (remote).
- Send `initialize` and `thread/start` RPC calls to establish a session.
- Execute turns via `turn/start` with streaming response handling.
- Handle dynamic tool calls via the `DynamicTool` executor.
- Auto-approve requested actions when `approval_policy` is `"never"`.
- Auto-answer tool input requests with placeholder responses.

**RPC methods:**

| Method | Purpose |
|--------|---------|
| `initialize` | Handshake with capabilities |
| `thread/start` | Create thread with approval policy |
| `turn/start` | Begin turn with prompt and sandbox policy |

**Message events:** `session_started`, `notification`, `approval_auto_approved`,
`turn_completed`, `turn_failed`, `tool_call_completed`, `tool_call_failed`.

**Configuration (from `WORKFLOW.md`):**

| Key | Description |
|-----|-------------|
| `codex.command` | Codex startup command |
| `codex.approval_policy` | `"never"` (auto-approve) or `"prompt"` |
| `codex.thread_sandbox` | Sandbox mode (e.g., `"danger-full-access"`) |
| `codex.turn_sandbox_policy` | Per-turn sandbox policy |
| `codex.read_timeout_ms` | Read timeout for RPC messages |
| `codex.turn_timeout_ms` | Maximum turn duration |

## Linear Integration

Symphony interacts with Linear through two API layers:

### Tracker API

Used for issue management via the `SymphonyElixir.Tracker` behaviour and its
`SymphonyElixir.Linear.Adapter` implementation.

**Operations:**

- `fetch_candidate_issues/0` — get issues in active states filtered by project or label.
- `fetch_issue_states_by_ids/1` — refresh issue state for continuation checks.
- `fetch_issue_comments/1` — get comments for prompt building.
- `create_comment/2`, `update_comment/2` — manage workpad and result comments.
- `update_issue_state/2` — transition issue state (resolves state name to ID).
- `add_issue_label/1` — add labels (e.g., pickup marker).
- `ensure_issue_resource_link/3` — attach PR links to issues.

**Auth:** Uses `LINEAR_API_KEY` or `LINEAR_OAUTH_TOKEN` with retry logic for rate limits.

### Agent API

Used for streaming session activities to the Linear Agent UI via
`SymphonyElixir.Linear.AgentAPI`.

**Operations:**

- `create_session_on_issue/1` — create a Linear agent session for an issue.
- `create_activity/2` — post activity (thoughts, actions, responses, errors).
- `update_session/2` — sync plan and external URLs.
- `complete_session/2` — finalize with outcome (`completed`, `failed`, `stopped`).

**Auth:** Uses `LINEAR_OAUTH_TOKEN` (app token). Rate limited with max 3 retries and exponential
backoff.

### Tracker Abstraction

`SymphonyElixir.Tracker` is a behaviour that abstracts tracker operations. Implementations:

- `SymphonyElixir.Linear.Adapter` — production Linear integration.
- `SymphonyElixir.Tracker.Memory` — in-memory implementation for testing.

## Issue Lifecycle

### State transitions

```
Backlog → Todo → In Progress → Human Review → Merging → Done
                      ↑              ↓
                      └── Rework ←───┘
```

- **Backlog** — queued by humans; orchestrator does not modify.
- **Todo** — eligible for pickup; orchestrator moves to In Progress on dispatch.
- **In Progress** — agent is actively working; turns execute until completion or max turns.
- **Human Review** — agent completed work and pushed a PR; waiting for human approval.
- **Merging** — human approved; agent lands the PR.
- **Rework** — reviewer requested changes; agent restarts from a fresh branch.
- **Done** — terminal state; no further action.

### Pickup flow

1. Orchestrator polls Linear for issues in `active_states` matching the project or label filter.
2. Orchestrator attempts an atomic `IssueClaim` insert to prevent duplicate dispatch.
3. On successful claim, orchestrator launches `AgentRunner.run/3` as a supervised task.
4. AgentRunner creates a workspace, runs hooks, starts an engine session.
5. First turn executes with the full issue context as prompt.

### Continuation flow

After each turn, AgentRunner checks whether to continue:

- Is the issue still in an `active_state`? (Refreshed via tracker API.)
- Is the turn count below `max_turns`?
- Does the issue still match the label filter (if label-based)?

If all conditions are met, a continuation turn runs with new comments and pending prompts merged
into the prompt.

### Webhook-driven re-poll

Linear webhooks can nudge the orchestrator to poll sooner:

1. `Linear.IssueWebhookHandler` receives the webhook.
2. Broadcasts `webhook_issue_hint` to all orchestrator instances.
3. Orchestrator records the hint and checks the issue on the next tick.

### Mid-run user prompts

Users can inject messages into a running session via Linear:

1. Webhook or API delivers a prompt to `AgentSession.inject_prompt/2`.
2. Prompt is queued in `pending_prompts`.
3. At the start of each continuation turn, `drain_pending_prompts/1` retrieves and clears the
   queue.
4. Pending prompts are merged with unseen comments into the continuation prompt.

## Multi-Orchestrator Coordination

Symphony supports multiple orchestrator instances running concurrently.

**IssueClaim mechanism:**

- Atomic database insert prevents two orchestrators from claiming the same issue.
- Claims store `orchestrator_key` and `claimed_at` timestamp.
- Released on issue completion or orchestrator shutdown.

**Stale claim recovery:**

- On startup, orchestrators release stale claims from previous instances.
- A 30-second grace period applies before sweeping stale sessions.

**Webhook broadcasting:**

- Linear webhooks arrive at a single endpoint.
- `IssueWebhookHandler` broadcasts hints to all orchestrator instances.
- Each orchestrator independently evaluates whether the issue is relevant.

## Error Handling and Retries

### Turn-level retries (AgentRunner)

- Triggered by `turn_failed` or `turn_cancelled` errors.
- Maximum retries: `max_turn_retries` (default 3).
- Backoff: `5s * 2^(attempt-1)`, capped at 30 seconds.
- Retry notifications emitted via `AgentSession`.

### Issue-level retries (Orchestrator)

- Triggered by agent task exit with error.
- Cooldown period per issue prevents rapid re-dispatch.
- If max turns reached but issue remains in active state, deferred to next poll.

### API retries

- Linear GraphQL: retries on 5xx responses.
- Linear Agent API: max 3 retries on rate limit (400), exponential backoff (`2s * 2^attempt`).
- Codex turn timeout: errors after `codex.turn_timeout_ms`.

## Persistence

### Session (`SymphonyElixir.Store.Session`)

Records each agent session with: issue ID, session ID, status (`running`, `completed`, `failed`,
`cancelled`), timestamps, turn count, token usage, workspace path, config snapshot, workflow name,
GitHub branch, estimated cost, and error details.

### IssueClaim (`SymphonyElixir.Store.IssueClaim`)

Atomic claim record keyed by `issue_id`. Stores orchestrator key and claim timestamp. Prevents
duplicate dispatch.

### Message (`SymphonyElixir.Store.Message`)

Persists engine messages (events + JSON payload) per session for debugging and audit.

### SessionLog (GenServer)

Accumulates turn events in-memory and periodically drains to the `Message` table.

## Observability

- **Structured logging** with `issue_id`, `issue_identifier`, `session_id`, and `workflow_name`
  context fields (see `docs/logging.md`).
- **Session debug endpoint** at `GET /api/v1/sessions/:id/debug` returns config snapshot, stderr,
  hook results, messages, and error summary.
- **SSE streams** at `/api/v1/stream/dashboard` and `/api/v1/stream/session/:issue_id` for live
  updates.
- **Linear Agent UI** receives real-time activities (thoughts, actions, responses) via the Agent
  API.

## Configuration

All runtime configuration lives in `WORKFLOW.md` YAML front matter, parsed by
`SymphonyElixir.Config` via `SymphonyElixir.Config.Schema`.

Key configuration sections:

- **`tracker`** — Linear connection, filter mode, active/terminal states.
- **`agent`** — concurrency limits, turn limits, retry settings.
- **`codex`** — engine command, approval policy, sandbox settings, timeouts.
- **`polling`** — poll interval.
- **`hooks`** — workspace lifecycle hooks (`after_create`, `before_run`, `after_run`,
  `before_remove`) and timeout.
- **`workspace`** — root directory for workspaces.
- **`engine`** — engine type (`"claude"` or `"codex"`).
- **`linear_agent`** — Linear Agent API settings and webhook signing secret.

See `WORKFLOW.md` in each project repository for the full configuration reference.
