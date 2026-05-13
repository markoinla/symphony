# linear-agent API v1 — shape spec

Target: a stable, MCP-ready REST surface on the `linear-agent` Worker that
covers CRUD for workflows, triggers, projects, settings, integrations
(read), tokens, and webhook event tails — plus an OpenAPI document and a
co-located MCP transport.

This document specifies the **target shape**. Where today's code already
matches, the section says so; otherwise the "Today" line records what's
in the tree at `workers/linear-agent/src/routes/api-v1.ts` /
`/dashboard/api/*` / `/admin/*` so we know what to migrate.

## Design decisions (locked)

- **Sessions stay implicit.** No `/api/v1/sessions` resource. Runs are
  driven by Linear webhooks → SessionRunner. MCP only manages config.
- **Workflows ↔ projects stay implicit.** Workflows match by
  `team_filter`; the runner resolves the project (repo, engine defaults)
  from the issue's team at dispatch time. No `workflows.project_id` FK.
- **Auth scopes are coarse.** `read`, `write`, `admin`. Cookie sessions
  hold all three implicitly.
- **One auth middleware** (`requireAuth` in
  `src/lib/auth/context.ts`) gates every `/api/v1/*` route. Cookie OR
  bearer; resolves to an `AuthContext { actor, scopes, orgId }`.

## Conventions

### URLs

- Versioned root: `/api/v1`. Breaking changes get a new prefix
  (`/api/v2`) — never break v1 in place.
- Resources are plural, kebab-case (`/workflows`, `/api-tokens`).
- Sub-resources nest one level only (`/workflows/:id/triggers`). Deeper
  joins are server-side concerns, not URL geometry.
- Lifecycle verbs are POST sub-resources, not PATCH state mutations:
  `POST /workflows/:id/publish`, `POST /workflows/:id/duplicate`. PUT
  is for editing fields.

### Identifiers

- All IDs are server-issued UUIDv4 strings. Clients never propose IDs.
- Composite addressing (`/admin/projects/:orgId/:linearTeamId`) is gone
  in v1 — projects are addressed by their D1 `id` like everything else.

### Timestamps

- All times are integer Unix seconds, named `*_at` (`created_at`,
  `updated_at`, `published_at`). Already the convention in the v1
  workflows handler — extend everywhere.

### Pagination

- Cursor-based, never offset. Two query params:
  - `?limit=<n>` (default 50, max 200)
  - `?before_id=<uuid>` (returns rows created strictly before this id)
- Responses include `next_cursor: string | null` alongside the array.
  Clients page until `next_cursor === null`.

### Idempotency

- Mutating routes accept `Idempotency-Key: <client-uuid>`. The Worker
  stores `(org_id, route, idempotency_key) → first_response` for 24h
  in KV. Duplicate keys within the window return the cached response
  byte-for-byte; the underlying side effect runs once.
- Today: no idempotency anywhere. Add a small KV-backed helper in
  `src/lib/idempotency.ts` and wrap the POST handlers.

### Errors

All error responses share this envelope:

```json
{
  "error": "<code>",
  "message": "<human-readable>",
  "issues": [ /* zod errors, optional */ ]
}
```

The `code` taxonomy:

| Code                | HTTP | When                                                        |
|---------------------|------|-------------------------------------------------------------|
| `unauthorized`      | 401  | No / invalid cookie or bearer                               |
| `forbidden`         | 403  | Authed but missing scope or wrong org                       |
| `not_found`         | 404  | Resource doesn't exist or doesn't belong to actor's org     |
| `validation_failed` | 400  | Zod parse failed; `issues` populated                        |
| `invalid_state`     | 409  | E.g. `PUT` on a published workflow                          |
| `conflict`          | 409  | Idempotency key reused with different body; unique violation|
| `rate_limited`      | 429  | Reserved; not enforced today                                |
| `dispatcher_error`  | 502  | Downstream dispatcher 4xx/5xx surfaced upstream             |
| `internal_error`    | 500  | Uncaught                                                    |

Today the v1 handler returns `{error: "..."}` strings without a
`message` field. Migration: thread a `respondError(c, code, message?, issues?)`
helper through and adjust tests.

## Auth

### Two credential surfaces

1. **Session cookie** (Better Auth). Dashboard SPA. Resolved to
   `actor.kind='user'`, `scopes=['read','write','admin']`.
2. **Bearer token** (`Authorization: Bearer <tok>`). MCP, CI, scripts.
   Resolved to `actor.kind='token'`, scopes from the token row.

Both produce the same `AuthContext`. Handlers downstream call
`requireScope(c, 'write')` for mutation.

### Scope matrix

| Scope   | Grants                                                      |
|---------|-------------------------------------------------------------|
| `read`  | All `GET` routes                                            |
| `write` | Mutations on workflows, triggers, projects, settings        |
| `admin` | Token CRUD; integrations writes; future destructive admin   |

Scope checks happen in the route, not the middleware — the middleware
only proves an `AuthContext`. A handler may also enforce per-resource
ownership (workflow.organization_id === auth.orgId) beyond the scope.

### Token lifecycle

```
POST   /api/v1/api-tokens          (admin) create — returns plaintext once
GET    /api/v1/api-tokens          (read)  list   — never returns plaintext
DELETE /api/v1/api-tokens/:id      (admin) revoke
```

Issuance:

- `POST /api/v1/api-tokens` body: `{ name, scopes: ['read'|'write'|'admin'][] }`
- Server generates `tok_<base64url(32 bytes)>`, hashes (SHA-256), inserts
  into `api_tokens` (table already exists, see migration 0002_workflows.sql).
- Response: `{ token: { id, name, scopes, created_at, plaintext } }`.
  `plaintext` only present on this one response.
- List response omits `plaintext` and `token_hash`; only shows
  `{ id, name, scopes, created_at, last_used_at }`.

A cookie session can mint tokens with `admin` scope.

## Resources

### 1. Workflows

Today: live at `/api/v1/workflows`, mostly correct. Listed here as the
target shape with deltas called out.

```
GET    /api/v1/workflows                 (read)
POST   /api/v1/workflows                 (write) Idempotency-Key
GET    /api/v1/workflows/:id             (read)
PUT    /api/v1/workflows/:id             (write) draft-only [new]
DELETE /api/v1/workflows/:id             (write)
POST   /api/v1/workflows/:id/publish     (write)
POST   /api/v1/workflows/:id/duplicate   (write) Idempotency-Key
POST   /api/v1/workflows/:id/preview     (read)
GET    /api/v1/workflows/resolve         (read)  debug helper
```

**Deltas from today:**

- `PUT` returns `409 invalid_state` when `status='published'`. Edits to
  a published workflow must go through "duplicate → edit → publish."
- `POST /workflows/:id/test-run` (currently 501) is **removed** from
  the surface. Re-add when implementation exists.
- `POST` and `POST /duplicate` accept `Idempotency-Key`.
- Error envelope is the standardized `{error, message, issues?}`.

**Schemas:** `WorkflowCreateSchema`, `WorkflowUpdateSchema`,
`WorkflowSchema` already in `src/schemas/workflow.ts`. No body changes.

**List filters:** `?status=draft|published|archived`, `?team_id=...`,
`?user_id=...` (server narrows by `auth.orgId` always).

### 2. Triggers

```
GET    /api/v1/workflows/:id/triggers    (read)
POST   /api/v1/workflows/:id/triggers    (write) Idempotency-Key
GET    /api/v1/triggers/:id              (read)
PUT    /api/v1/triggers/:id              (write)
DELETE /api/v1/triggers/:id              (write)
```

Today: exists, correct shape. Same deltas as workflows (idempotency,
error envelope). No state-machine gate on triggers — they're editable
in place because they don't have versions.

**Schemas:** `TriggerCreateSchema`, `TriggerUpdateSchema` in
`src/schemas/trigger.ts`.

### 3. Projects

New under v1. Mirror the existing `/dashboard/api/projects` handler
behavior with a Zod schema and bearer auth.

```
GET    /api/v1/projects                  (read)
POST   /api/v1/projects                  (write) Idempotency-Key
GET    /api/v1/projects/:id              (read)
PUT    /api/v1/projects/:id              (write)
DELETE /api/v1/projects/:id              (write)
```

**Schema** (`src/schemas/project.ts`, new):

```ts
ProjectCreateSchema = z.object({
  linear_team_id:           z.string().min(1),
  linear_team_name:         z.string().optional(),
  repo_url:                 z.string().url().regex(/^https?:\/\//),
  default_branch:           z.string().default('main'),
  engine:                   z.string().default('pi'),
  model:                    z.string().nullable().optional(),
  max_turns:                z.number().int().positive().max(100).optional(),
  scope:                    z.string().nullable().optional(),
  system_prompt_override:   z.string().nullable().optional(),
})

ProjectUpdateSchema = ProjectCreateSchema.partial()

ProjectSchema = ProjectCreateSchema.extend({
  id:               z.string(),
  organization_id:  z.string(),
  created_at:       z.number().int(),
  updated_at:       z.number().int(),
})
```

**Unique constraint:** `(organization_id, linear_team_id)`. POST with a
duplicate returns `409 conflict` rather than the current "upsert"
behavior on `/dashboard/api/projects`. Upsert semantics belong on the
dashboard handler (it's UX-driven); the v1 surface is explicit.

**Deprecation:** `/admin/projects` and `/dashboard/api/projects` writes
remain for backward compatibility but log a deprecation header
(`Sunset: <date>`). After the dashboard is migrated to call
`/api/v1/projects` with the user's cookie, those handlers can be
removed.

### 4. Settings

```
GET    /api/v1/settings                  (read)
GET    /api/v1/settings/:key             (read)
PUT    /api/v1/settings/:key             (write)
DELETE /api/v1/settings/:key             (write)
```

Mirror `/dashboard/api/settings`. Response also includes
`agent_defaults` (env-derived) on the list endpoint, matching today.

Curated-key validation (`agent.default_engine`, `agent.default_model`,
`agent.max_turns`) is preserved via the same `validateSettingValue`
helper.

### 5. Integrations (read-only)

```
GET    /api/v1/integrations              (read)
```

Returns the connected-status payload that today's
`/dashboard/api/integrations` returns: `{ linear, github, anthropic,
openai, cf_workers_ai, github_app_settings_url }`.

**Why no writes:** OAuth callbacks need a session cookie to land the
install on the right user. The connect/disconnect flows stay on
`/dashboard/api/*` and `/oauth/*`. MCP can see what's connected and
reason about it, but installing GitHub is a human action.

The `PUT /dashboard/api/integrations/credentials` endpoint (used to
configure provider API keys) does need a v1 equivalent eventually
because it's pure key paste — but defer to a second pass:

```
PUT    /api/v1/integrations/credentials  (admin)   [deferred]
```

### 6. Webhook events

```
GET    /api/v1/webhook-events            (read)
GET    /api/v1/webhook-events/:id        (read)
```

Renamed from `/api/v1/webhooks` for consistency (the route is *events*,
not *webhook configurations*).

**Deltas from today:**

- Path rename. Old path stays as an alias for one release with a
  deprecation header.
- Cursor pagination via `?before_id=`, `?limit=` (today: `?limit=` only).
- Filters: `?envelope=...`, `?dispatched_action=...` (today's filters
  preserved), plus `?signature_ok=true|false`, `?deduped=true|false`,
  `?since_ts=...` for incident triage.
- List response truncates `raw_body` at 8KB (today). Detail endpoint
  returns full body.

### 7. API tokens

See [Auth → Token lifecycle](#token-lifecycle).

```
GET    /api/v1/api-tokens                (read)
POST   /api/v1/api-tokens                (admin)
DELETE /api/v1/api-tokens/:id            (admin)
```

## OpenAPI document

Wire `@hono/zod-openapi` so the existing Zod schemas drive a generated
`/openapi.json`. Concrete steps:

1. Replace `new Hono()` with `new OpenAPIHono()` in
   `src/routes/api-v1.ts`.
2. Convert each route definition to `createRoute({ ... })` with the
   Zod schemas wired as `request.body.content['application/json'].schema`
   and `responses[...].content['application/json'].schema`.
3. Mount `app.doc('/openapi.json', { ... })` at the worker root.
4. Add a smoke test that fetches `/openapi.json` and asserts each v1
   route appears with a `requestBody` or `parameters` block.

The result is the artifact the MCP shim consumes — every tool's
input/output schema is generated, not hand-maintained.

## MCP transport

Co-located on the same Worker so we share auth + DB + KV. No second
deploy.

```
POST   /mcp                              JSON-RPC over POST
GET    /mcp/sse                          server→client event stream
```

Transport: [MCP HTTP+SSE transport](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports#http-with-sse).

**Auth:** bearer-only. The cookie path isn't useful here — MCP clients
don't carry browser cookies. A token's scopes determine which tools
are advertised to the client.

**Tool surface:** mostly 1:1 with v1 routes. Each MCP tool wraps a
single REST handler and re-uses the same Zod input schema.

| MCP tool                  | Backing route                                  | Scope   |
|---------------------------|------------------------------------------------|---------|
| `workflows.list`          | `GET /api/v1/workflows`                        | read    |
| `workflows.get`           | `GET /api/v1/workflows/:id`                    | read    |
| `workflows.create`        | `POST /api/v1/workflows`                       | write   |
| `workflows.update`        | `PUT /api/v1/workflows/:id`                    | write   |
| `workflows.delete`        | `DELETE /api/v1/workflows/:id`                 | write   |
| `workflows.publish`       | `POST /api/v1/workflows/:id/publish`           | write   |
| `workflows.duplicate`     | `POST /api/v1/workflows/:id/duplicate`         | write   |
| `workflows.preview`       | `POST /api/v1/workflows/:id/preview`           | read    |
| `workflows.resolve`       | `GET /api/v1/workflows/resolve`                | read    |
| `triggers.list`           | `GET /api/v1/workflows/:id/triggers`           | read    |
| `triggers.create`         | `POST /api/v1/workflows/:id/triggers`          | write   |
| `triggers.get/update/delete` | `…/triggers/:id`                            | read/write |
| `projects.*`              | `/api/v1/projects/…`                           | read/write |
| `settings.list/get/set/delete` | `/api/v1/settings/…`                      | read/write |
| `integrations.status`     | `GET /api/v1/integrations`                     | read    |
| `webhook_events.list/get` | `/api/v1/webhook-events/…`                     | read    |

Token CRUD is **not** exposed via MCP — agents shouldn't issue agent
credentials. Token mgmt stays REST-only behind the `admin` scope and
the dashboard.

Implementation sketch: `src/routes/mcp.ts` hosts the JSON-RPC dispatch
and tool registry. Each tool's `handler` builds a synthetic
`Request` and calls the v1 route directly via `app.fetch()`, so we
never duplicate validation, persistence, or error envelope logic.

## Build order

1. **Foundations** (no behavior change visible to clients):
   - `respondError(c, code, message?, issues?)` helper + standardized
     error envelope; thread through existing v1 routes.
   - KV-backed `withIdempotency()` wrapper.
   - Cursor pagination helper.
   - `requireScope(c, scope)` helper.
2. **Tokens + scope enforcement** (SYM-296):
   - `POST/GET/DELETE /api/v1/api-tokens`.
   - Dashboard UI for token issuance.
   - Replace `scopes: ['*']` on the cookie path with
     `['read','write','admin']`.
   - Tests: bearer-only routes 401 without scope; cookie sessions pass
     everywhere.
3. **Projects + settings + integrations under v1.**
   - Migrate dashboard SPA to call `/api/v1/projects` with cookie.
   - Add `Sunset:` headers on `/admin/projects` and `/dashboard/api/projects`
     writes.
4. **Workflows tightening.**
   - Drop `/test-run`.
   - `PUT` gates on `status='draft'`.
   - Add cursor pagination to list.
5. **Webhook events rename + filters.**
6. **OpenAPI document** via `@hono/zod-openapi`.
7. **MCP transport** at `/mcp` and `/mcp/sse`.

Each step ships behind feature parity tests so existing dashboard
clients (cookie sessions) keep working through the whole migration.

## What stays out of v1

- **Sessions / runs.** Implicit via Linear webhooks only. If/when MCP
  needs to start a run, we add `POST /api/v1/sessions` then.
- **Linear / GitHub OAuth flows.** Cookie-only on `/oauth/*` and
  `/dashboard/api/integrations/*`.
- **Admin smoke + sandbox stop.** Stay on `/admin/*` — operator-only.
- **Workflow versions read API.** Add `GET /api/v1/workflows/:id/versions`
  in a follow-up if anyone needs it; today only `publish` writes to
  the table.
