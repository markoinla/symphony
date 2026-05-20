# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Repository layout.** This repo contains the Elixir/Phoenix Symphony orchestrator (`lib/`, `dashboard/`, `config/`, `test/`, `mix.exs`, the `WORKFLOW.md` family) plus the **`workers/oauth-proxy`** Cloudflare Worker (TypeScript) used for OAuth brokering.
>
> **`linear-agent` and `sandbox-dispatcher` have moved.** They now live in [`markoinla/linear-agent`](https://github.com/markoinla/linear-agent) — that repo owns their code, CI, ops scripts (`deploy-workers.sh`, `rotate-dispatch-secret.sh`, `smoke-dispatch.sh`, `debug-session.sh`, `debug-sandbox.sh`), and architecture/integration docs. The migration replaces the Elixir `Orchestrator` + `Tracker` + `Linear.*` modules (SYM-386); new orchestration work belongs there.
>
> `workers/oauth-proxy` has its own `CLAUDE.md`. **When working under `workers/oauth-proxy`, follow that file — not this one.** The Elixir conventions below (mix, `@spec`, Ecto, `WORKFLOW.md` front matter) do **not** apply to it.

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
./bin/symphony ./WORKFLOW.md   # Run the orchestrator directly via escript (README entry point)

# Build
mix assets.build           # Build dashboard SPA and copy into priv/static/dashboard
mix build                  # assets.build + escript.build → ./bin/symphony

# Fast validation (use this for pre-commit/pre-push checks)
mix compile --warnings-as-errors && mix format --check-formatted && mix lint
mix specs.check            # @spec enforcement on public funs (also runs as part of `mix lint`)
cd dashboard && npm run lint   # Frontend ESLint

# Run specific tests only — prefer targeted tests over full suite
mix test path/to/test.exs           # Run a single test file
mix test path/to/test.exs:42        # Run a specific test by line number

# Live end-to-end test (creates real Linear resources + spawns Codex; opt-in only)
SYMPHONY_RUN_LIVE_E2E=1 mix test test/symphony_elixir/live_e2e_test.exs
# Optional: SYMPHONY_LIVE_LINEAR_TEAM_KEY (default SYME2E), SYMPHONY_LIVE_SSH_WORKER_HOSTS

# User management
mix symphony.create_user <email> <password> [--name "Name"]  # Add users after first-time /setup
```

## Architecture

### Backend (Elixir)

The core pipeline flows: **Orchestrator** → **AgentRunner** → **Workspace** → **Codex AppServer**.

- `SymphonyElixir.Orchestrator` — GenServer that polls Linear for candidate issues, dispatches agents, handles retries and reconciliation. Stateful and concurrency-sensitive.
- `SymphonyElixir.AgentRunner` — Executes a single issue in an isolated workspace with Codex.
- `SymphonyElixir.Workspace` — Creates per-issue workspaces (local or SSH workers). **Safety-critical: never run Codex in the source repo.**
- `SymphonyElixir.Codex.AppServer` / `SymphonyElixir.Claude.AppServer` — Engine adapters for Codex and Claude app-server sessions (start, turn, tool responses). Both engines are supported side-by-side.
- `SymphonyElixir.Store` — PostgreSQL persistence layer with Ecto schemas for Projects, Sessions, Messages, Settings, IssueClaims, Users, Organizations, UserOrganizations, Agents, WebhookLogs, WebhookHints.
- `SymphonyElixir.Config` / `Config.Schema` — Parses YAML front matter from `WORKFLOW.md` files. Workflow files hot-reload from disk; on reload failure the last good config is retained.
- `SymphonyElixir.Linear.*` — Linear GraphQL API client (polling, comments, state transitions, labels, OAuth, webhooks).
- `SymphonyElixir.Tracker` — Abstract tracker interface with Linear and memory implementations.
- `SymphonyElixir.Worker.*` — SSH worker support; workspaces can be local or executed on remote SSH hosts.
- `SymphonyElixir.Cloudflare.DispatcherClient` — Talks to the `sandbox-dispatcher` Worker ([`markoinla/linear-agent`](https://github.com/markoinla/linear-agent)) for sandboxed run dispatch. Shared `DISPATCH_HMAC_SECRET`.

**Workflow files:** `WORKFLOW.md` is the primary config, but Symphony also ships sibling workflows (`ENRICHMENT.md`, `EPIC_SPLITTER.md`, `MENTION.md`, `MERGING.md`, `REVIEW.md`, `TRIAGE.md`) at the repo root. Pass multiple paths or a directory via `--workflows <dir>` to run one orchestrator per workflow.

### Frontend (React Dashboard)

Located in `dashboard/`. Built with Vite, served as static assets from Phoenix in production.

- **Routing:** TanStack Router. Pages under `dashboard/src/pages/`: `dashboard`, `session`, `history`, `agents`, `analytics`, `reliability`, `projects`, `settings`, `login`, `setup`.
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

**First-time bootstrap:** when no users exist, `SymphonyElixirWeb.Plugs.RequireAuth` lets all requests through. Visit `/setup` to create the first admin + default organization, then connect Linear OAuth and create a project in the dashboard. Once any user exists, a valid `user_id` session is required on protected routes. Add more users via `mix symphony.create_user`.

**Protected (session required when users exist):**
- `GET /api/v1/state` — Orchestrator state snapshot
- `GET /api/v1/sessions` — Session history (filterable by `workflow_name`, `issue_identifier`, `status`, `project_id`)
- `GET /api/v1/sessions/:id/debug` — Full session debug payload (config, stderr, hooks, messages, summary)
- `GET /api/v1/stream/dashboard` — SSE dashboard updates
- `GET /api/v1/stream/session/:issue_id` — SSE session timeline
- `GET/POST /api/v1/projects` — Project CRUD
- `GET/PUT/DELETE /api/v1/settings/:key` — Settings management

## Database

PostgreSQL runs in Docker (`symphony-postgres`). Connect with:

```bash
PGPASSWORD=postgres psql -h localhost -U postgres -d symphony_dev
```

## Debugging

### System diagnostics

`GET /diagnostics` — unauthenticated, returns a comprehensive snapshot for production troubleshooting:

```bash
curl localhost:4000/diagnostics | jq .
```

Sections: `system` (OTP/Elixir version, uptime, memory, BEAM process counts, registry counts), `orchestrator` (running/retrying agents, engine totals, rate limits), `workflows` (per-workflow config, polling/webhook settings, worker mode), `database` (session counts by status, pool config), `issue_claims` (active dispatch locks), `worker_health` (24h per-host failure rates), `dead_letters` (permanently failed sessions), `webhooks` (last 20 events), `error_distribution` (24h error counts by category), `projects`, `recent_errors` (last 20).

### Session debugging

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

## Cloudflare Workers ops

`linear-agent` + `sandbox-dispatcher` (and their deploy/smoke/rotate/debug
scripts, integration docs, and failure-mode postmortem) live in
[`markoinla/linear-agent`](https://github.com/markoinla/linear-agent).
That repo owns prod deploys for both Workers — Symphony's GitHub Actions
no longer deploys them.

What still lives in this repo is the **client side**:

- `SymphonyElixir.Cloudflare.DispatcherClient` — HMAC-signed POST `/run`
  caller; shares `DISPATCH_HMAC_SECRET` with the dispatcher Worker.
- `mix symphony.baseline.edit` / `mix symphony.baseline.save` — engine
  baseline editor that talks to the dispatcher over its public URL:

  ```bash
  export SYMPHONY_DISPATCHER_URL=https://sandbox.marko.la
  export SYMPHONY_DISPATCHER_HMAC_SECRET=$(op item get twhncf7ryksvdjx424x74nbmiy --fields credential --reveal)
  export DATABASE_URL=ecto://postgres:postgres@localhost/symphony_dev

  mise exec -- mix symphony.baseline.edit --engine pi    # prints pty_url (browser, ~30 min TTL)
  mise exec -- mix symphony.baseline.save --engine pi    # snapshots /home/symphony + destroys sandbox
  ```

  The current baseline is restored into the edit sandbox first, so changes
  are additive. `--version <tag>` on save is optional; existing tag is
  preserved if omitted.

For deploy scripts, secret rotation, sandbox SSH, the
`DISPATCH_HMAC_SECRET` drift postmortem, and engine-baseline alias
internals, see the
[`linear-agent` repo's `workers/CLAUDE.md`](https://github.com/markoinla/linear-agent/blob/main/workers/CLAUDE.md)
and `workers/docs/cloudflare_sandbox_integration.md`.

## Code Conventions

- All public functions (`def`) must have an adjacent `@spec`. Private (`defp`) specs are optional. `@impl` callbacks are exempt.
- Runtime config is loaded from `WORKFLOW.md` YAML front matter via `SymphonyElixir.Workflow` and `SymphonyElixir.Config`. Prefer `SymphonyElixir.Config` over ad-hoc env reads.
- Follow `docs/logging.md`: include `issue_id`, `issue_identifier`, and `session_id` context fields in logs.
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
