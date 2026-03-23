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
- `GET /api/v1/state` — Orchestrator state snapshot
- `GET /api/v1/sessions` — Session history
- `GET /api/v1/stream/dashboard` — SSE dashboard updates
- `GET /api/v1/stream/session/:issue_id` — SSE session timeline
- `GET/POST /api/v1/projects` — Project CRUD
- `GET/PUT/DELETE /api/v1/settings/:key` — Settings management

## Code Conventions

- All public functions (`def`) must have an adjacent `@spec`. Private (`defp`) specs are optional. `@impl` callbacks are exempt.
- Runtime config is loaded from `WORKFLOW.md` YAML front matter via `SymphonyElixir.Workflow` and `SymphonyElixir.Config`. Prefer `SymphonyElixir.Config` over ad-hoc env reads.
- Follow `docs/logging.md`: include `issue_id`, `issue_identifier`, and `session_id` context fields in logs.
- Keep the implementation aligned with `docs/SPEC.md` — must not conflict, update spec if behavior changes.
- Tests use `SymphonyElixir.TestSupport` (via `use`). Test helpers live in `test/support/`.
- PR bodies must follow `.github/pull_request_template.md`. Validate with `mix pr_body.check --file <path>`.

## Docs Update Policy

If behavior/config changes, update docs in the same PR:
- `README.md` for project concept and run instructions
- `AGENTS.md` for Elixir implementation conventions
- `WORKFLOW.md` for workflow/config contract changes
