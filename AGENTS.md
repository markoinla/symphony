# Symphony Elixir

This directory contains the Elixir agent orchestration service that polls Linear, creates per-issue workspaces, and runs Codex in app-server mode.

## Environment

- Elixir: `1.19.x` (OTP 28) via `mise`.
- Install deps: `mix setup`.
- Fast validation: `mix compile --warnings-as-errors && mix format --check-formatted && mix lint`


## Codebase-Specific Conventions

- Runtime config is loaded from `WORKFLOW.md` front matter via `SymphonyElixir.Workflow` and `SymphonyElixir.Config`.
- Keep the implementation aligned with [`../SPEC.md`](../SPEC.md) where practical.
  - The implementation may be a superset of the spec.
  - The implementation must not conflict with the spec.
  - If implementation changes meaningfully alter the intended behavior, update the spec in the same
    change where practical so the spec stays current.
- Prefer adding config access through `SymphonyElixir.Config` instead of ad-hoc env reads.
- Workspace safety is critical:
  - Never run Codex turn cwd in source repo.
  - Workspaces must stay under configured workspace root.
- Orchestrator behavior is stateful and concurrency-sensitive; preserve retry, reconciliation, and cleanup semantics.
- Follow `docs/logging.md` for logging conventions and required issue/session context fields.

## Authentication

- `SymphonyElixir.Accounts` is the context module for user authentication and account management. It wraps `Store` CRUD with password verification, existence checks, and multi-step registration (user + org + membership).
- `SymphonyElixirWeb.Plugs.RequireAuth` enforces session-based auth. When no users exist in the DB, all requests pass through (auth is unconfigured). Once any user exists, a valid `user_id` session is required.
- `SymphonyElixirWeb.AuthController` handles login, setup, logout, and status endpoints under `/api/v1/auth/*`.
- First-time setup: `POST /api/v1/auth/setup` creates the first user, default organization, and owner membership.
- Additional users: `mix symphony.create_user <email> <password> [--name "Name"]`.

## Tests and Validation

Run targeted tests while iterating, then run fast validation before handoff.

```bash
mix compile --warnings-as-errors && mix format --check-formatted && mix lint
```

## Required Rules

- Public functions (`def`) in `lib/` must have an adjacent `@spec`.
- `defp` specs are optional.
- `@impl` callback implementations are exempt from local `@spec` requirement.
- Keep changes narrowly scoped; avoid unrelated refactors.
- Follow existing module/style patterns in `lib/symphony_elixir/*`.

Validation command:

```bash
mix specs.check
```

## PR Requirements

- PR body must follow `../.github/pull_request_template.md` exactly.
- Validate PR body locally when needed:

```bash
mix pr_body.check --file /path/to/pr_body.md
```

## Docs Update Policy

If behavior/config changes, update docs in the same PR:

- `../README.md` for project concept and goals.
- `README.md` for Elixir implementation and run instructions.
- `WORKFLOW.md` for workflow/config contract changes.
