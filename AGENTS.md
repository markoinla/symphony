# Symphony

This repository contains two distinct stacks:

1. **Elixir/Phoenix app** at the repo root (`lib/`, `dashboard/`, `config/`, `test/`, `mix.exs`, `WORKFLOW.md` files). These instructions apply to the Elixir app.
2. **Cloudflare Workers** under `workers/linear-agent`, `workers/sandbox-dispatcher`, and `workers/oauth-proxy`. Each worker has its own `CLAUDE.md`; follow that file when working inside that worker. Root Elixir conventions (`mix`, `@spec`, Ecto, `WORKFLOW.md` front matter) do not apply there.

`workers/linear-agent` is the in-progress replacement for the Elixir `Orchestrator`, `Tracker`, and `Linear.*` modules (migration SYM-386). New orchestration work should usually go there instead of the Elixir app.

## Environment

- Elixir: `1.19.x` (OTP 28) via `mise`.
- Backend: Phoenix 1.8, PostgreSQL, Ecto.
- Dashboard: React 19 + TypeScript + Vite under `dashboard/`.
- Install deps: `mix setup`.
- Start Phoenix: `mix phx.server`.
- Start dashboard dev server: `cd dashboard && npm run dev` (Vite on port 5173, proxies `/api` to `:4000`).
- Build dashboard + escript: `mix build`.
- Run orchestrator directly: `./bin/symphony ./WORKFLOW.md`.
- Fast validation: `mix compile --warnings-as-errors && mix format --check-formatted && mix lint`.

## Architecture

- `SymphonyElixir.Orchestrator` polls Linear, dispatches agents, handles retries, and reconciles state. It is stateful and concurrency-sensitive.
- `SymphonyElixir.AgentRunner` executes a single issue in an isolated workspace with an engine adapter.
- `SymphonyElixir.Workspace` creates local or SSH-backed per-issue workspaces. Workspace safety is critical.
- `SymphonyElixir.Codex.AppServer` and `SymphonyElixir.Claude.AppServer` run Codex and Claude app-server sessions side by side.
- `SymphonyElixir.Store` owns PostgreSQL persistence with Ecto schemas for sessions, messages, settings, issue claims, users, organizations, agents, webhook logs, and related data.
- `SymphonyElixir.Config` and `SymphonyElixir.Workflow` parse YAML front matter from workflow files. Workflow files hot-reload; reload failure keeps the last good config.
- `SymphonyElixir.Linear.*` contains the Linear GraphQL client, OAuth, webhooks, state transitions, labels, and comments.
- `SymphonyElixir.Tracker` is the tracker abstraction with Linear and memory implementations.
- `SymphonyElixir.Worker.*` supports remote SSH workers.
- `SymphonyElixir.Cloudflare.DispatcherClient` calls the `workers/sandbox-dispatcher` Worker for sandboxed runs.

`WORKFLOW.md` is the primary workflow config. Sibling root workflows include `ENRICHMENT.md`, `EPIC_SPLITTER.md`, `MENTION.md`, `MERGING.md`, `REVIEW.md`, and `TRIAGE.md`. Multiple paths or a directory may be passed with `--workflows <dir>`.

## Codebase-Specific Conventions

- Prefer adding config access through `SymphonyElixir.Config` instead of ad-hoc env reads.
- Workspace safety is critical:
  - Never run Codex turn cwd in the source repo.
  - Workspaces must stay under the configured workspace root.
- Preserve orchestrator retry, reconciliation, cleanup, and concurrency semantics.
- Follow `docs/logging.md`; logs should carry issue/session context fields such as `issue_id`, `issue_identifier`, `workflow_name`, and `session_id` where applicable.
- Use `SymphonyElixir.TestSupport` in tests. Helpers live in `test/support/`.
- Keep changes narrowly scoped and follow existing module/style patterns in `lib/symphony_elixir/*`.

## Required Rules

- Public functions (`def`) in `lib/` must have an adjacent `@spec`.
- Private functions (`defp`) may have specs but do not require them.
- `@impl` callback implementations are exempt from the local `@spec` requirement.
- Validate public function specs with `mix specs.check`.

## Authentication

- `SymphonyElixir.Accounts` is the context module for user authentication and account management. It wraps `Store` CRUD with password verification, existence checks, and multi-step registration (user + org + membership).
- `SymphonyElixirWeb.Plugs.RequireAuth` enforces session auth. When no users exist in the DB, requests pass through; once any user exists, protected routes require a valid `user_id` session.
- `SymphonyElixirWeb.AuthController` handles login, setup, logout, and status endpoints under `/api/v1/auth/*`.
- First-time setup: `POST /api/v1/auth/setup` creates the first user, default organization, and owner membership.
- Additional users: `mix symphony.create_user <email> <password> [--name "Name"]`.

## API and Debugging

- REST JSON API lives under `/api/v1/*`.
- Session debugging: `GET /api/v1/sessions/:id/debug`.
- Dashboard SSE: `GET /api/v1/stream/dashboard`.
- Session SSE: `GET /api/v1/stream/session/:issue_id`.
- System diagnostics: `GET /diagnostics` is unauthenticated and returns system, orchestrator, workflow, database, issue claim, worker health, dead letter, webhook, error distribution, project, and recent error snapshots.

When debugging a failed session, check `stderr`, `hook_results`, `config_snapshot`, `error`, and `summary.error_message_count` first.

## Tests and Validation

Run targeted tests while iterating, then fast validation before handoff.

```bash
mix test path/to/test.exs
mix test path/to/test.exs:42
mix compile --warnings-as-errors && mix format --check-formatted && mix lint
mix specs.check
cd dashboard && npm run lint
```

Live end-to-end tests create real Linear resources and spawn Codex; run only when explicitly needed:

```bash
SYMPHONY_RUN_LIVE_E2E=1 mix test test/symphony_elixir/live_e2e_test.exs
```

## Cloudflare Workers Notes

The TypeScript workers have their own instructions:

- `workers/linear-agent/CLAUDE.md`
- `workers/sandbox-dispatcher/CLAUDE.md`
- `workers/oauth-proxy/CLAUDE.md`

For the `linear-agent` and `sandbox-dispatcher` HMAC pair, use the helper scripts under `workers/scripts/` instead of deploying or rotating secrets one worker at a time:

```bash
workers/scripts/deploy-workers.sh
workers/scripts/deploy-workers.sh dispatcher
workers/scripts/deploy-workers.sh linear-agent
workers/scripts/rotate-dispatch-secret.sh
workers/scripts/smoke-dispatch.sh
workers/scripts/debug-session.sh <session-id>
workers/scripts/debug-sandbox.sh <run-id> [turn]
```

`workers/scripts/smoke-dispatch.sh`, `workers/scripts/debug-session.sh`, and
`workers/scripts/debug-sandbox.sh` need the `linear-agent` `ADMIN_TOKEN`. Export
`LINEAR_AGENT_ADMIN_TOKEN` or put the token in `.secrets/admin-token`.

For a failed or stuck Worker-backed agent run, start with:

```bash
workers/scripts/debug-session.sh <session-id>
```

This returns the `linear-agent` session metadata, issue fields, config
snapshot, session-level error, stderr, dispatcher logs, and persisted
normalized engine events. If the run is still active or failed with
`run_terminal_timeout`, also run:

```bash
workers/scripts/debug-sandbox.sh <session-id> 1
```

The sandbox debug command returns the derived dispatcher sandbox id,
process id, process metadata, and stdout/stderr tails when the
sandbox/process still exists. Historical sessions may report no process
or logs after cleanup; in that case use the persisted session events
from `debug-session`.

`oauth-proxy` is not part of that HMAC pair and is deployed from its own directory.

## Linear

When creating Linear issues, use these defaults unless instructed otherwise:

- Team: Symphony (`SYM`, `e6ff2862-1971-4b10-88a8-4aa16137fff0`)
- Project: Symphony Agent Workflow (`1d28e4e4-1505-40f0-8369-69b7ec05435d`)
- Default status: Backlog

Available statuses: Backlog, Staged, Todo, In Progress, Merging, Rework, Human Review, Done, Canceled, Duplicate.

## PR Requirements

- PR body must follow `.github/pull_request_template.md` exactly.
- Validate PR body locally when needed:

```bash
mix pr_body.check --file /path/to/pr_body.md
```

## Docs Update Policy

If behavior/config changes, update docs in the same PR:

- `README.md` for project concept and run instructions.
- `WORKFLOW.md` for workflow/config contract changes.
- `AGENTS.md` for Elixir implementation conventions.
- Relevant worker `CLAUDE.md` or `README.md` when behavior changes under `workers/`.
