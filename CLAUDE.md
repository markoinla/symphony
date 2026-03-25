# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Symphony is an Elixir/OTP agent orchestration service that polls Linear for issues, creates per-issue workspaces, and runs Codex in app-server mode. It includes a React dashboard for observability.

**Stack:** Elixir 1.19 (OTP 28) + Phoenix 1.8 backend, React 19 + TypeScript + Vite frontend, PostgreSQL database.

## Common Commands

```bash
# Setup
mix setup                  # Install Elixir + npm dependencies

# Development
mix phx.server             # Start Phoenix API server
cd dashboard && npm run dev # Start Vite dev server (port 5173, proxies /api to :4000)

# Fast validation (use this for pre-commit/pre-push checks)
mix compile --warnings-as-errors && mix format --check-formatted && mix lint

# Run specific tests only — prefer targeted tests over full suite
mix test path/to/test.exs           # Run a single test file
mix test path/to/test.exs:42        # Run a specific test by line number
```

## Architecture

### Backend (Elixir)

The core pipeline flows: **Orchestrator** → **AgentRunner** → **Workspace** → **Codex AppServer**.

- `SymphonyElixir.Orchestrator` — GenServer that polls Linear for candidate issues, dispatches agents, handles retries and reconciliation. Stateful and concurrency-sensitive.
- `SymphonyElixir.AgentRunner` — Executes a single issue in an isolated workspace with Codex.
- `SymphonyElixir.Workspace` — Creates per-issue workspaces (local or SSH workers). **Safety-critical: never run Codex in the source repo.**
- `SymphonyElixir.Codex.AppServer` — Manages Codex app-server sessions (start, turn, tool responses).
- `SymphonyElixir.Store` — SQLite persistence layer with Ecto schemas for Projects, Sessions, Messages, Settings, IssueClaims.
- `SymphonyElixir.Config` / `Config.Schema` — Parses YAML front matter from `WORKFLOW.md` files.
- `SymphonyElixir.Linear.*` — Linear GraphQL API client (polling, comments, state transitions, labels).
- `SymphonyElixir.Tracker` — Abstract tracker interface with Linear and memory implementations.

### Frontend (React Dashboard)

Located in `dashboard/`. Built with Vite, served as static assets from Phoenix in production.

- **Routing:** TanStack Router (dashboard, session detail, history views)
- **Data fetching:** TanStack Query + SSE streams for live updates
- **UI:** Radix UI primitives + Tailwind CSS
- **Key files:** `src/lib/api.ts` (API client + types), `src/lib/streams.ts` (SSE), `src/lib/utils.ts`

### API

REST JSON API under `/api/v1/*`:

**Auth (no session required):**
- `POST /api/v1/auth/login` — body: `{email, password}`, response: `{ok: true, user: {id, email, name}}` or 401
- `POST /api/v1/auth/setup` — body: `{email, password, name?}`, creates first user + org; 409 if already configured
- `POST /api/v1/auth/logout` — clears session
- `GET /api/v1/auth/status` — response: `{authenticated, auth_required, user?}` (user present when logged in)

**Protected (session required when users exist):**
- `GET /api/v1/state` — Orchestrator state snapshot
- `GET /api/v1/sessions` — Session history (filterable by `workflow_name`, `issue_identifier`, `status`, `project_id`)
- `GET /api/v1/sessions/:id/debug` — Full session debug payload (config, stderr, hooks, messages, summary)
- `GET /api/v1/stream/dashboard` — SSE dashboard updates
- `GET /api/v1/stream/session/:issue_id` — SSE session timeline
- `GET/POST /api/v1/projects` — Project CRUD
- `GET/PUT/DELETE /api/v1/settings/:key` — Settings management

## Debugging Sessions

Use the debug endpoint to get a complete picture of any session:

```bash
# Full debug context for a session (metadata, config, stderr, hook results, messages)
curl localhost:4000/api/v1/sessions/42/debug

# Filter sessions by workflow or issue
curl localhost:4000/api/v1/sessions?workflow_name=EPIC_SPLITTER
curl localhost:4000/api/v1/sessions?issue_identifier=SYM-162
```

**What to check first on a failed session:**
1. `stderr` — Codex subprocess errors (port crashes, startup failures)
2. `hook_results` — workspace hook failures that prevented the agent from starting
3. `config_snapshot` — whether model/max_turns/permission_mode were correct at session start
4. `error` — the session-level error message
5. `summary.error_message_count` — how many error messages occurred during the run

Logger metadata includes `workflow_name`, `issue_id`, `issue_identifier`, and `session_id` for log correlation.

## Code Conventions

- All public functions (`def`) must have an adjacent `@spec`. Private (`defp`) specs are optional. `@impl` callbacks are exempt.
- Runtime config is loaded from `WORKFLOW.md` YAML front matter via `SymphonyElixir.Workflow` and `SymphonyElixir.Config`. Prefer `SymphonyElixir.Config` over ad-hoc env reads.
- Follow `docs/logging.md`: include `issue_id`, `issue_identifier`, and `session_id` context fields in logs.
- Keep the implementation aligned with `docs/SPEC.md` — must not conflict, update spec if behavior changes.
- Tests use `SymphonyElixir.TestSupport` (via `use`). Test helpers live in `test/support/`.
- PR bodies must follow `.github/pull_request_template.md`. Validate with `mix pr_body.check --file <path>`.

## Linear

When creating issues, use these defaults unless instructed otherwise:

- **Team:** Symphony (key: `SYM`, ID: `e6ff2862-1971-4b10-88a8-4aa16137fff0`)
- **Project:** Symphony Agent Workflow (ID: `1d28e4e4-1505-40f0-8369-69b7ec05435d`)
- **Default status:** Backlog

Available statuses: Backlog, Staged, Todo, In Progress, Merging, Rework, Human Review, Done, Canceled, Duplicate.

## Docs Update Policy

If behavior/config changes, update docs in the same PR:
- `README.md` for project concept and run instructions
- `AGENTS.md` for Elixir implementation conventions
- `WORKFLOW.md` for workflow/config contract changes
