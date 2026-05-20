# Symphony

This repository contains the **Elixir/Phoenix Symphony app** at the repo root (`lib/`, `dashboard/`, `config/`, `test/`, `mix.exs`, `WORKFLOW.md` files), plus the **`workers/oauth-proxy`** Cloudflare Worker (TypeScript) used for OAuth brokering. The Worker has its own `CLAUDE.md`; Elixir conventions (`mix`, `@spec`, Ecto, `WORKFLOW.md` front matter) do not apply there.

`linear-agent` and `sandbox-dispatcher` have moved to [`markoinla/linear-agent`](https://github.com/markoinla/linear-agent). The migration replaces the Elixir `Orchestrator`, `Tracker`, and `Linear.*` modules (SYM-386); new orchestration work belongs in that repo.

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
- `SymphonyElixir.Cloudflare.DispatcherClient` calls the `sandbox-dispatcher` Worker ([`markoinla/linear-agent`](https://github.com/markoinla/linear-agent)) for sandboxed runs. Shared `DISPATCH_HMAC_SECRET`.

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

`oauth-proxy` (the only Worker left in this repo) has its own instructions in
`workers/oauth-proxy/CLAUDE.md`. It is deployed from its own directory and is
unrelated to the `linear-agent` / `sandbox-dispatcher` HMAC pair.

For deploys, secret rotation, smoke checks, and session/sandbox debugging of
the `linear-agent` and `sandbox-dispatcher` Workers, see the
[`markoinla/linear-agent`](https://github.com/markoinla/linear-agent) repo
(`workers/CLAUDE.md` and `workers/scripts/*`).

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
