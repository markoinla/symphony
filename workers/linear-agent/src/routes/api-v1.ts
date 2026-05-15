// /api/v1/* — public REST surface for workflows + triggers.
//
// Mounted alongside the existing dashboard-api router. All routes go
// through the unified `requireAuth` middleware (session cookie OR
// bearer token; bearer always returns 401 today since api_tokens is
// empty until SYM-296). Bodies are Zod-validated against the shared
// schemas in src/schemas/* (Track 1).
//
// Response shape:
//   { workflow: WorkflowRow }       on single returns
//   { workflows: WorkflowRow[] }    on list returns
//   { error: string, issues?: ... } on failures (Zod errors include `issues`)

import { z } from "zod";
import { Hono, type Context } from "hono";

import type { Env } from "../index";
import type { AuthVariables } from "../lib/auth/context";
import { requireAuth } from "../lib/auth/context";
import { hashToken } from "../lib/auth/bearer";
import { requireScope, requireScopeForMethod } from "../lib/auth/scope";
import { respondError } from "../lib/responses";
import { dispatchTrigger } from "../lib/dispatch-trigger";
import { resolveWorkflow } from "../lib/workflows/resolver";
import { renderPrompt } from "../lib/workflows/render";
import { CredentialStore } from "../lib/credentials";
import { withIdempotency } from "../lib/idempotency";
import { nextCursorFrom, parsePagination } from "../lib/pagination";
import { buildAgentDefaults, validateSettingValue } from "../lib/settings";
import {
  GitHubInstallStore,
  LinearAgentInstallStore,
  ProjectStore,
  SettingStore,
  WebhookEventStore,
  WebhookSourceStore,
  type WebhookEventRecord,
  type WebhookSourceRecord,
} from "../lib/store";
import { ApiTokenCreateSchema } from "../schemas/api-token";
import {
  ProjectCreateSchema,
  ProjectUpdateSchema,
} from "../schemas/project";
import {
  TriggerCreateSchema,
  TriggerUpdateSchema,
} from "../schemas/trigger";
import {
  WebhookSourceCreateSchema,
  WebhookSourceUpdateSchema,
} from "../schemas/webhook-source";
import {
  eventTupleSchema,
  SubjectRefSchema,
  type EventTuple,
} from "../schemas/event";
import type { Trigger } from "../schemas/trigger";
import type { Workflow } from "../schemas/workflow";
import {
  unsupportedRuntimePolicyIssues,
  WorkflowCreateSchema,
  WorkflowUpdateSchema,
} from "../schemas/workflow";

// ────────────────────────────────────────────────────────────────────
// Row shapes — mirror migrations/0002_workflows.sql exactly.
// ────────────────────────────────────────────────────────────────────

interface WorkflowRow {
  id: string;
  organization_id: string | null;
  team_id: string | null;
  user_id: string | null;
  name: string;
  description: string | null;
  engine: string;
  model: string | null;
  max_turns: number;
  max_continuations: number | null;
  allowed_tools: string | null;
  disallowed_tools: string | null;
  allowed_domains: string | null;
  mcp_servers: string | null;
  permission_mode: string | null;
  additional_read_paths: string | null;
  additional_write_paths: string | null;
  hook_after_create: string | null;
  hook_before_remove: string | null;
  hook_timeout_ms: number;
  prompt_template: string;
  version: number;
  status: string;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TriggerRow {
  id: string;
  workflow_id: string;
  event_type: string;
  to_state: string | null;
  from_state: string | null;
  label_name: string | null;
  comment_match: string | null;
  team_filter: string | null;
  project_filter: string | null;
  label_filter: string | null;
  skip_label_filter: string | null;
  assignee_filter: string | null;
  repo_filter: string | null;
  branch_filter: string | null;
  base_filter: string | null;
  draft_filter: number | null;
  author_filter: string | null;
  action: string;
  action_params: string | null;
  priority: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

const WORKFLOW_COLS =
  "id, organization_id, team_id, user_id, name, description, engine, model, max_turns, max_continuations, allowed_tools, disallowed_tools, allowed_domains, mcp_servers, permission_mode, additional_read_paths, additional_write_paths, hook_after_create, hook_before_remove, hook_timeout_ms, prompt_template, version, status, published_at, created_at, updated_at";

const TRIGGER_COLS =
  "id, workflow_id, event_type, to_state, from_state, label_name, comment_match, team_filter, project_filter, label_filter, skip_label_filter, assignee_filter, repo_filter, branch_filter, base_filter, draft_filter, author_filter, action, action_params, priority, enabled, created_at, updated_at";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function jsonOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return JSON.stringify(v);
}

function asJsonArray(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Hydrate a stored workflow row into the API-facing shape. JSON-array
// columns are parsed back to arrays; everything else is structural.
function serializeWorkflow(row: WorkflowRow): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    team_id: row.team_id,
    user_id: row.user_id,
    name: row.name,
    description: row.description,
    engine: row.engine,
    model: row.model,
    max_turns: row.max_turns,
    max_continuations: row.max_continuations,
    allowed_tools: asJsonArray(row.allowed_tools),
    disallowed_tools: asJsonArray(row.disallowed_tools),
    allowed_domains: asJsonArray(row.allowed_domains),
    mcp_servers: asJsonArray(row.mcp_servers),
    permission_mode: row.permission_mode,
    additional_read_paths: asJsonArray(row.additional_read_paths),
    additional_write_paths: asJsonArray(row.additional_write_paths),
    hook_after_create: row.hook_after_create,
    hook_before_remove: row.hook_before_remove,
    hook_timeout_ms: row.hook_timeout_ms,
    prompt_template: row.prompt_template,
    version: row.version,
    status: row.status,
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeTrigger(row: TriggerRow): Record<string, unknown> {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    event_type: row.event_type,
    to_state: row.to_state,
    from_state: row.from_state,
    label_name: row.label_name,
    comment_match: row.comment_match,
    team_filter: asJsonArray(row.team_filter),
    project_filter: asJsonArray(row.project_filter),
    label_filter: asJsonArray(row.label_filter),
    skip_label_filter: asJsonArray(row.skip_label_filter),
    assignee_filter: asJsonArray(row.assignee_filter),
    repo_filter: asJsonArray(row.repo_filter),
    branch_filter: asJsonArray(row.branch_filter),
    base_filter: asJsonArray(row.base_filter),
    draft_filter: row.draft_filter == null ? null : row.draft_filter !== 0,
    author_filter: asJsonArray(row.author_filter),
    action: row.action,
    action_params: asJsonObject(row.action_params),
    priority: row.priority,
    enabled: row.enabled !== 0,
    expected_subject_kinds: row.event_type.startsWith("github.pr.")
      ? ["github_pr"]
      : row.event_type === "api.invoke"
        ? ["linear_issue", "generic", "github_pr"]
        : ["linear_issue"],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Body schema for `/preview` — Track 1's workflow schemas don't include
// this since it's API-layer-only.
const PreviewRequestSchema = z.object({
  issue_id: z.string().min(1),
});

const TriggerInvokeRequestSchema = z.object({
  subject: SubjectRefSchema,
  context: z.record(z.string(), z.unknown()).optional().default({}),
});

const WEBHOOK_BODY_LIST_LIMIT = 8 * 1024;

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `whsec_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function serializeWebhookSource(
  row: WebhookSourceRecord,
  opts: { includeSecret?: boolean } = {},
): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    kind: row.kind,
    name: row.name,
    config: parseJsonRecord(row.config) ?? {},
    inbound_url: `/webhook/source/${row.id}`,
    ...(opts.includeSecret ? { secret: row.secret } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeWebhookEvent(
  row: WebhookEventRecord,
  truncate: boolean,
): Record<string, unknown> {
  const body =
    truncate && row.raw_body && row.raw_body.length > WEBHOOK_BODY_LIST_LIMIT
      ? row.raw_body.slice(0, WEBHOOK_BODY_LIST_LIMIT) + "…"
      : row.raw_body;
  return {
    id: row.id,
    received_at: row.received_at,
    organization_id: row.organization_id,
    source_id: row.source_id,
    webhook_id: row.webhook_id,
    envelope_type: row.envelope_type,
    envelope_action: row.envelope_action,
    signature_ok: row.signature_ok === 1,
    deduped: row.deduped === 1,
    matched_workflow_id: row.matched_workflow_id,
    matched_trigger_id: row.matched_trigger_id,
    dispatched_action: row.dispatched_action,
    agent_session_id: row.agent_session_id,
    error: row.error,
    latency_ms: row.latency_ms,
    event_summary: row.event_summary,
    raw_body: body,
    raw_body_truncated:
      truncate &&
      !!row.raw_body &&
      row.raw_body.length > WEBHOOK_BODY_LIST_LIMIT,
  };
}

// ────────────────────────────────────────────────────────────────────
// Router
// ────────────────────────────────────────────────────────────────────

export function buildApiV1Router() {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  // All /api/v1/* routes require a valid AuthContext.
  app.use("/api/v1/*", requireAuth());

  // Per-resource scope enforcement. GET → read, mutations → write,
  // except api-tokens (admin on POST/DELETE — checked inline).
  const rwScopes = requireScopeForMethod({
    GET: "read",
    POST: "write",
    PUT: "write",
    DELETE: "write",
  });
  app.use("/api/v1/workflows", rwScopes);
  app.use("/api/v1/workflows/*", rwScopes);
  app.use("/api/v1/triggers/*", async (c, next) => {
    if (
      c.req.method === "POST" &&
      c.req.path.match(/^\/api\/v1\/triggers\/[^/]+\/invoke$/)
    ) {
      const denied = requireScope(c, "triggers:invoke");
      if (denied) return denied;
      await next();
      return;
    }
    return rwScopes(c, next);
  });
  app.use("/api/v1/webhooks", rwScopes);
  app.use("/api/v1/webhooks/*", rwScopes);
  app.use("/api/v1/webhook-events", rwScopes);
  app.use("/api/v1/webhook-events/*", rwScopes);
  app.use("/api/v1/webhook-sources", async (c, next) => {
    const denied = requireScope(c, "write");
    if (denied) return denied;
    await next();
  });
  app.use("/api/v1/webhook-sources/*", async (c, next) => {
    const denied = requireScope(c, "write");
    if (denied) return denied;
    await next();
  });
  app.use("/api/v1/projects", rwScopes);
  app.use("/api/v1/projects/*", rwScopes);
  app.use("/api/v1/settings", rwScopes);
  app.use("/api/v1/settings/*", rwScopes);
  app.use("/api/v1/integrations", rwScopes);

  // ── Workflows ────────────────────────────────────────────────────

  app.get("/api/v1/workflows", async (c) => {
    const auth = c.get("auth");
    const { limit, beforeId } = parsePagination(c);
    const status = c.req.query("status") || undefined;
    const teamId = c.req.query("team_id") || undefined;
    const userId = c.req.query("user_id") || undefined;

    // Cursor row — fetch the (created_at, id) of the before_id anchor so
    // the WHERE clause can use SQLite tuple comparison. Anchor outside
    // the org is treated as "no cursor" (defensive, mirrors not_found).
    let cursorTs: number | null = null;
    if (beforeId) {
      const anchor = await c.env.DB.prepare(
        "SELECT created_at FROM workflows WHERE id = ? AND organization_id = ?",
      )
        .bind(beforeId, auth.orgId)
        .first<{ created_at: number }>();
      if (anchor) cursorTs = anchor.created_at;
    }

    const filters: string[] = ["organization_id = ?"];
    const bindings: unknown[] = [auth.orgId];
    if (status) {
      filters.push("status = ?");
      bindings.push(status);
    }
    if (teamId) {
      filters.push("team_id = ?");
      bindings.push(teamId);
    }
    if (userId) {
      filters.push("user_id = ?");
      bindings.push(userId);
    }
    if (cursorTs !== null && beforeId) {
      filters.push("(created_at, id) < (?, ?)");
      bindings.push(cursorTs, beforeId);
    }
    bindings.push(limit);

    const result = await c.env.DB.prepare(
      `SELECT ${WORKFLOW_COLS} FROM workflows
       WHERE ${filters.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
      .bind(...bindings)
      .all<WorkflowRow>();

    const rows = result.results ?? [];
    return c.json({
      workflows: rows.map(serializeWorkflow),
      next_cursor: nextCursorFrom(rows, limit),
    });
  });

  app.post("/api/v1/workflows", async (c) =>
    withIdempotency(c, "POST /api/v1/workflows", async () => {
    const auth = c.get("auth");
    const raw = await c.req.json().catch(() => null);
    const parsed = WorkflowCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(
        c,
        "validation_failed",
        undefined,
        parsed.error.issues,
      );
    }
    const unsupportedIssues = unsupportedRuntimePolicyIssues(
      parsed.data as Record<string, unknown>,
    );
    if (unsupportedIssues.length > 0) {
      return respondError(c, "validation_failed", undefined, unsupportedIssues);
    }
    const input = parsed.data;
    const id = crypto.randomUUID();
    const ts = nowSec();

    await c.env.DB.prepare(
      `INSERT INTO workflows (
         id, organization_id, team_id, user_id, name, description,
         engine, model, max_turns, max_continuations,
         allowed_tools, disallowed_tools, allowed_domains, mcp_servers,
         permission_mode, additional_read_paths, additional_write_paths,
         hook_after_create, hook_before_remove, hook_timeout_ms,
         prompt_template, version, status, created_at, updated_at
       ) VALUES (
         ?, ?, NULL, NULL, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, 1, 'draft', ?, ?
       )`,
    )
      .bind(
        id,
        auth.orgId,
        input.name,
        input.description ?? null,
        input.engine,
        input.model ?? null,
        input.max_turns,
        input.max_continuations ?? null,
        jsonOrNull(input.allowed_tools),
        jsonOrNull(input.disallowed_tools),
        jsonOrNull(input.allowed_domains),
        jsonOrNull(input.mcp_servers),
        input.permission_mode ?? null,
        jsonOrNull(input.additional_read_paths),
        jsonOrNull(input.additional_write_paths),
        input.hook_after_create ?? null,
        input.hook_before_remove ?? null,
        input.hook_timeout_ms,
        input.prompt_template,
        ts,
        ts,
      )
      .run();

    const row = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!row) return respondError(c, "internal_error", "Insert failed.");
    return c.json({ workflow: serializeWorkflow(row) }, 201);
    }),
  );

  // ── Resolve — debug helper ──────────────────────────────────────
  // Register this static route before /:id so Hono cannot capture
  // `resolve` as a workflow id.

  app.get("/api/v1/workflows/resolve", async (c) => {
    const auth = c.get("auth");
    const eventType = c.req.query("event_type");
    const issueId = c.req.query("issue_id");
    if (!eventType)
      return respondError(c, "validation_failed", "Missing `event_type` query parameter.");

    // The shared eventTupleSchema is a discriminated union; build the
    // shape variant-by-variant. The debug helper supports the simple
    // forms — state_entered, comment_added, etc.
    const candidate = buildResolveEvent(eventType, auth.orgId, issueId, c);
    if (!candidate)
      return respondError(c, "validation_failed", `Unsupported event_type: ${eventType}`);
    const parsed = eventTupleSchema.safeParse(candidate);
    if (!parsed.success) {
      return respondError(
        c,
        "validation_failed",
        undefined,
        parsed.error.issues,
      );
    }
    const result = await resolveWorkflow(c.env, parsed.data);
    return c.json({ result });
  });

  app.get("/api/v1/workflows/:id", async (c) => {
    const auth = c.get("auth");
    const row = await getWorkflow(c.env.DB, c.req.param("id"), auth.orgId);
    if (!row) return respondError(c, "not_found");
    return c.json({ workflow: serializeWorkflow(row) });
  });

  app.put("/api/v1/workflows/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => null);
    const parsed = WorkflowUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(
        c,
        "validation_failed",
        undefined,
        parsed.error.issues,
      );
    }
    const unsupportedIssues = unsupportedRuntimePolicyIssues(
      parsed.data as Record<string, unknown>,
    );
    if (unsupportedIssues.length > 0) {
      return respondError(c, "validation_failed", undefined, unsupportedIssues);
    }
    const input = parsed.data;

    const existing = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!existing) return respondError(c, "not_found");

    // Published workflows are editable in place — matches dashboard UX
    // where users expect Save to just work. Explicit POST /publish
    // still snapshots into `workflow_versions` when you want a versioned
    // checkpoint; ad-hoc PUTs overwrite the live content without
    // bumping `version`.

    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, value: unknown) => {
      sets.push(`${col} = ?`);
      values.push(value);
    };

    if (input.name !== undefined) set("name", input.name);
    if (input.description !== undefined)
      set("description", input.description ?? null);
    if (input.engine !== undefined) set("engine", input.engine);
    if (input.model !== undefined) set("model", input.model ?? null);
    if (input.max_turns !== undefined) set("max_turns", input.max_turns);
    if (input.max_continuations !== undefined)
      set("max_continuations", input.max_continuations ?? null);
    if (input.allowed_tools !== undefined)
      set("allowed_tools", jsonOrNull(input.allowed_tools));
    if (input.disallowed_tools !== undefined)
      set("disallowed_tools", jsonOrNull(input.disallowed_tools));
    if (input.allowed_domains !== undefined)
      set("allowed_domains", jsonOrNull(input.allowed_domains));
    if (input.mcp_servers !== undefined)
      set("mcp_servers", jsonOrNull(input.mcp_servers));
    if (input.permission_mode !== undefined)
      set("permission_mode", input.permission_mode ?? null);
    if (input.additional_read_paths !== undefined)
      set("additional_read_paths", jsonOrNull(input.additional_read_paths));
    if (input.additional_write_paths !== undefined)
      set("additional_write_paths", jsonOrNull(input.additional_write_paths));
    if (input.hook_after_create !== undefined)
      set("hook_after_create", input.hook_after_create ?? null);
    if (input.hook_before_remove !== undefined)
      set("hook_before_remove", input.hook_before_remove ?? null);
    if (input.hook_timeout_ms !== undefined)
      set("hook_timeout_ms", input.hook_timeout_ms);
    if (input.prompt_template !== undefined)
      set("prompt_template", input.prompt_template);

    if (sets.length === 0) {
      return c.json({ workflow: serializeWorkflow(existing) });
    }

    set("updated_at", nowSec());
    values.push(id, auth.orgId);

    await c.env.DB.prepare(
      `UPDATE workflows SET ${sets.join(", ")}
       WHERE id = ? AND organization_id = ?`,
    )
      .bind(...values)
      .run();

    const updated = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!updated) return respondError(c, "not_found");
    return c.json({ workflow: serializeWorkflow(updated) });
  });

  app.delete("/api/v1/workflows/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const res = await c.env.DB.prepare(
      "DELETE FROM workflows WHERE id = ? AND organization_id = ?",
    )
      .bind(id, auth.orgId)
      .run();
    if ((res.meta?.changes ?? 0) === 0)
      return respondError(c, "not_found");
    return c.json({ ok: true });
  });

  // ── Publish — snapshot row + flip status ─────────────────────────

  app.post("/api/v1/workflows/:id/publish", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const existing = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!existing) return respondError(c, "not_found");

    const ts = nowSec();
    const version = existing.version;
    const versionId = crypto.randomUUID();
    const snapshot = JSON.stringify(serializeWorkflow(existing));

    await c.env.DB.prepare(
      `INSERT INTO workflow_versions (id, workflow_id, version, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(versionId, id, version, snapshot, ts)
      .run();

    await c.env.DB.prepare(
      `UPDATE workflows
       SET status = 'published', published_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ?`,
    )
      .bind(ts, ts, id, auth.orgId)
      .run();

    const updated = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!updated) return respondError(c, "not_found");
    return c.json({
      workflow: serializeWorkflow(updated),
      version: { id: versionId, version, created_at: ts },
    });
  });

  // ── Duplicate ────────────────────────────────────────────────────

  app.post("/api/v1/workflows/:id/duplicate", async (c) =>
    withIdempotency(c, `POST /api/v1/workflows/${c.req.param("id")}/duplicate`, async () => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const src = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!src) return respondError(c, "not_found");

    const newId = crypto.randomUUID();
    const ts = nowSec();
    await c.env.DB.prepare(
      `INSERT INTO workflows (
         id, organization_id, team_id, user_id, name, description,
         engine, model, max_turns, max_continuations,
         allowed_tools, disallowed_tools, allowed_domains, mcp_servers,
         permission_mode, additional_read_paths, additional_write_paths,
         hook_after_create, hook_before_remove, hook_timeout_ms,
         prompt_template, version, status, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, 1, 'draft', ?, ?
       )`,
    )
      .bind(
        newId,
        src.organization_id,
        src.team_id,
        src.user_id,
        `${src.name} (copy)`,
        src.description,
        src.engine,
        src.model,
        src.max_turns,
        src.max_continuations,
        src.allowed_tools,
        src.disallowed_tools,
        src.allowed_domains,
        src.mcp_servers,
        src.permission_mode,
        src.additional_read_paths,
        src.additional_write_paths,
        src.hook_after_create,
        src.hook_before_remove,
        src.hook_timeout_ms,
        src.prompt_template,
        ts,
        ts,
      )
      .run();

    const row = await getWorkflow(c.env.DB, newId, auth.orgId);
    if (!row) return respondError(c, "internal_error", "Duplicate failed.");
    return c.json({ workflow: serializeWorkflow(row) }, 201);
    }),
  );

  // ── Preview — render the prompt template against an issue ───────

  app.post("/api/v1/workflows/:id/preview", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => null);
    const parsed = PreviewRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(
        c,
        "validation_failed",
        undefined,
        parsed.error.issues,
      );
    }

    const row = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!row) return respondError(c, "not_found");

    // Track 1's renderPrompt takes a typed PromptContext; the issue
    // payload here is a placeholder until /preview gets enriched with
    // real Linear data (out of scope for this PR).
    const rendered = await renderPrompt(row.prompt_template, {
      issue: {
        id: parsed.data.issue_id,
        labels: [],
        comments: [],
      },
      attempt: 1,
      prompt_context: "",
      new_comments: [],
    });
    return c.json({ rendered });
  });

  // ── Triggers ────────────────────────────────────────────────────

  app.get("/api/v1/workflows/:id/triggers", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const workflow = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!workflow) return respondError(c, "not_found");

    const result = await c.env.DB.prepare(
      `SELECT ${TRIGGER_COLS} FROM workflow_triggers
       WHERE workflow_id = ?
       ORDER BY priority DESC, created_at ASC`,
    )
      .bind(id)
      .all<TriggerRow>();
    return c.json({ triggers: (result.results ?? []).map(serializeTrigger) });
  });

  app.post("/api/v1/workflows/:id/triggers", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const workflow = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!workflow) return respondError(c, "not_found");

    const raw = await c.req.json().catch(() => null);
    const parsed = TriggerCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(
        c,
        "validation_failed",
        undefined,
        parsed.error.issues,
      );
    }
    const t = parsed.data;
    const triggerId = crypto.randomUUID();
    const ts = nowSec();

    await c.env.DB.prepare(
      `INSERT INTO workflow_triggers (
         id, workflow_id, event_type,
         to_state, from_state, label_name, comment_match,
         team_filter, project_filter, label_filter, skip_label_filter, assignee_filter,
         repo_filter, branch_filter, base_filter, draft_filter, author_filter,
         action, action_params, priority, enabled, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
      .bind(
        triggerId,
        id,
        t.event_type,
        t.to_state ?? null,
        t.from_state ?? null,
        t.label_name ?? null,
        t.comment_match ?? null,
        jsonOrNull(t.team_filter),
        jsonOrNull(t.project_filter),
        jsonOrNull(t.label_filter),
        jsonOrNull(t.skip_label_filter),
        jsonOrNull(t.assignee_filter),
        jsonOrNull(t.repo_filter),
        jsonOrNull(t.branch_filter),
        jsonOrNull(t.base_filter),
        t.draft_filter == null ? null : t.draft_filter ? 1 : 0,
        jsonOrNull(t.author_filter),
        t.action,
        jsonOrNull(t.action_params),
        t.priority,
        t.enabled ? 1 : 0,
        ts,
        ts,
      )
      .run();

    const row = await getTrigger(c.env.DB, triggerId);
    if (!row) return respondError(c, "internal_error", "Insert failed.");
    return c.json({ trigger: serializeTrigger(row) }, 201);
  });

  app.post("/api/v1/triggers/:id/invoke", async (c) =>
    withIdempotency(c, `POST /api/v1/triggers/${c.req.param("id")}/invoke`, async () => {
      const auth = c.get("auth");
      const triggerId = c.req.param("id");
      const started = Date.now();
      const raw = await c.req.json().catch(() => null);
      const rawBody = raw === null ? null : JSON.stringify(raw);
      const audit = new WebhookEventStore(c.env.DB);
      const auditId = await audit.insert({
        receivedAt: nowSec(),
        organizationId: auth.orgId,
        webhookId: c.req.header("Idempotency-Key") ?? null,
        envelopeType: "api.invoke",
        envelopeAction: "trigger.invoke",
        signatureOk: true,
        rawBody,
        eventSummary: `${auth.actor.kind}:${auth.actor.id} invoked ${triggerId}`,
      });

      const parsed = TriggerInvokeRequestSchema.safeParse(raw);
      if (!parsed.success) {
        await audit.update(auditId, {
          dispatchedAction: "validation_failed",
          error: "validation_failed",
          latencyMs: Date.now() - started,
        });
        return respondError(
          c,
          "validation_failed",
          undefined,
          parsed.error.issues,
        );
      }

      const joined = await getTriggerAndWorkflow(c.env.DB, triggerId, auth.orgId);
      if (!joined) {
        await audit.update(auditId, {
          dispatchedAction: "not_found",
          error: "not_found",
          latencyMs: Date.now() - started,
        });
        return respondError(c, "not_found");
      }
      const { trigger, workflow } = joined;
      if (!trigger.enabled) {
        await audit.update(auditId, {
          dispatchedAction: "not_found",
          error: "disabled_trigger",
          latencyMs: Date.now() - started,
        });
        return respondError(c, "not_found");
      }
      if (trigger.event_type !== "api.invoke") {
        await audit.update(auditId, {
          matchedWorkflowId: workflow.id,
          matchedTriggerId: trigger.id,
          dispatchedAction: "validation_failed",
          error: "wrong_event_type",
          latencyMs: Date.now() - started,
        });
        return respondError(
          c,
          "validation_failed",
          "Only triggers with event_type `api.invoke` can be invoked directly.",
        );
      }

      const { subject, context } = parsed.data;
      const event: EventTuple = {
        event_type: "api.invoke",
        organization_id: auth.orgId,
        team_id:
          subject.kind === "linear_issue"
            ? (subject.team_id ?? workflow.team_id ?? null)
            : (workflow.team_id ?? null),
        project_id: subject.kind === "linear_issue" ? subject.project_id ?? null : null,
        user_id: workflow.user_id ?? null,
        assignee_id: subject.kind === "linear_issue" ? subject.assignee_id ?? null : null,
        labels: subject.kind === "linear_issue" ? subject.labels : [],
        subject,
        issue: subject.kind === "linear_issue" ? subject : null,
        actor_id: auth.actor.id,
        context,
      };

      const result = await dispatchTrigger(c.env, {
        workflow,
        trigger,
        event,
        context,
        source: "api",
      });

      await audit.update(auditId, {
        matchedWorkflowId: workflow.id,
        matchedTriggerId: trigger.id,
        dispatchedAction: result.outcome,
        agentSessionId: result.agentSessionId ?? null,
        error: result.error ?? null,
        latencyMs: Date.now() - started,
      });

      if (result.outcome === "error") {
        return respondError(c, "internal_error", result.error ?? "dispatch_failed");
      }
      if (result.outcome === "no_handler") {
        return respondError(c, "validation_failed", result.error ?? "no_handler");
      }
      return c.json({ session_id: result.agentSessionId }, 202);
    }),
  );

  app.get("/api/v1/triggers/:id", async (c) => {
    const auth = c.get("auth");
    const row = await getTriggerWithOrg(c.env.DB, c.req.param("id"), auth.orgId);
    if (!row) return respondError(c, "not_found");
    return c.json({ trigger: serializeTrigger(row) });
  });

  app.put("/api/v1/triggers/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const existing = await getTriggerWithOrg(c.env.DB, id, auth.orgId);
    if (!existing) return respondError(c, "not_found");

    const raw = await c.req.json().catch(() => null);
    const parsed = TriggerUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(
        c,
        "validation_failed",
        undefined,
        parsed.error.issues,
      );
    }
    const t = parsed.data;
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, value: unknown) => {
      sets.push(`${col} = ?`);
      values.push(value);
    };

    if (t.event_type !== undefined) set("event_type", t.event_type);
    if (t.action !== undefined) set("action", t.action);
    if (t.priority !== undefined) set("priority", t.priority);
    if (t.enabled !== undefined) set("enabled", t.enabled ? 1 : 0);
    if (t.to_state !== undefined) set("to_state", t.to_state ?? null);
    if (t.from_state !== undefined) set("from_state", t.from_state ?? null);
    if (t.label_name !== undefined) set("label_name", t.label_name ?? null);
    if (t.comment_match !== undefined)
      set("comment_match", t.comment_match ?? null);
    if (t.team_filter !== undefined)
      set("team_filter", jsonOrNull(t.team_filter));
    if (t.project_filter !== undefined)
      set("project_filter", jsonOrNull(t.project_filter));
    if (t.label_filter !== undefined)
      set("label_filter", jsonOrNull(t.label_filter));
    if (t.skip_label_filter !== undefined)
      set("skip_label_filter", jsonOrNull(t.skip_label_filter));
    if (t.assignee_filter !== undefined)
      set("assignee_filter", jsonOrNull(t.assignee_filter));
    if (t.repo_filter !== undefined)
      set("repo_filter", jsonOrNull(t.repo_filter));
    if (t.branch_filter !== undefined)
      set("branch_filter", jsonOrNull(t.branch_filter));
    if (t.base_filter !== undefined)
      set("base_filter", jsonOrNull(t.base_filter));
    if (t.draft_filter !== undefined)
      set("draft_filter", t.draft_filter == null ? null : t.draft_filter ? 1 : 0);
    if (t.author_filter !== undefined)
      set("author_filter", jsonOrNull(t.author_filter));
    if (t.action_params !== undefined)
      set("action_params", jsonOrNull(t.action_params));

    if (sets.length === 0) {
      return c.json({ trigger: serializeTrigger(existing) });
    }

    set("updated_at", nowSec());
    values.push(id);

    await c.env.DB.prepare(
      `UPDATE workflow_triggers SET ${sets.join(", ")} WHERE id = ?`,
    )
      .bind(...values)
      .run();

    const updated = await getTrigger(c.env.DB, id);
    if (!updated) return respondError(c, "not_found");
    return c.json({ trigger: serializeTrigger(updated) });
  });

  app.delete("/api/v1/triggers/:id", async (c) => {
    const auth = c.get("auth");
    const existing = await getTriggerWithOrg(c.env.DB, c.req.param("id"), auth.orgId);
    if (!existing) return respondError(c, "not_found");
    await c.env.DB.prepare("DELETE FROM workflow_triggers WHERE id = ?")
      .bind(existing.id)
      .run();
    return c.json({ ok: true });
  });

  // ── Webhook sources ─────────────────────────────────────────────

  app.get("/api/v1/webhook-sources", async (c) => {
    const auth = c.get("auth");
    const sources = await new WebhookSourceStore(c.env.DB).list(auth.orgId);
    return c.json({
      webhook_sources: sources.map((s) => serializeWebhookSource(s)),
    });
  });

  app.post("/api/v1/webhook-sources", async (c) => {
    const auth = c.get("auth");
    const raw = await c.req.json().catch(() => null);
    const parsed = WebhookSourceCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(c, "validation_failed", undefined, parsed.error.issues);
    }
    const input = parsed.data;
    const source = await new WebhookSourceStore(c.env.DB).create({
      organizationId: auth.orgId,
      kind: input.kind,
      name: input.name,
      secret: generateWebhookSecret(),
      config: input.config,
    });
    if (!source) return respondError(c, "internal_error", "Insert failed.");
    return c.json({ webhook_source: serializeWebhookSource(source, { includeSecret: true }) }, 201);
  });

  app.get("/api/v1/webhook-sources/:id", async (c) => {
    const auth = c.get("auth");
    const source = await new WebhookSourceStore(c.env.DB).getById(c.req.param("id"), auth.orgId);
    if (!source) return respondError(c, "not_found");
    return c.json({ webhook_source: serializeWebhookSource(source) });
  });

  app.put("/api/v1/webhook-sources/:id", async (c) => {
    const auth = c.get("auth");
    const raw = await c.req.json().catch(() => null);
    const parsed = WebhookSourceUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(c, "validation_failed", undefined, parsed.error.issues);
    }
    const input = parsed.data;
    const source = await new WebhookSourceStore(c.env.DB).update(
      c.req.param("id"),
      auth.orgId,
      {
        name: input.name,
        config: input.config,
        secret: input.rotate_secret ? generateWebhookSecret() : undefined,
      },
    );
    if (!source) return respondError(c, "not_found");
    return c.json({
      webhook_source: serializeWebhookSource(source, { includeSecret: input.rotate_secret }),
    });
  });

  app.delete("/api/v1/webhook-sources/:id", async (c) => {
    const auth = c.get("auth");
    const removed = await new WebhookSourceStore(c.env.DB).delete(c.req.param("id"), auth.orgId);
    if (!removed) return respondError(c, "not_found");
    return c.json({ ok: true });
  });

  // ── Webhook events — read-only tail for the dashboard ───────────
  //
  // Canonical path is /api/v1/webhook-events. /api/v1/webhooks is kept
  // for one release with a Sunset header (the path was renamed because
  // the resource is *events*, not webhook configurations).

  const WEBHOOK_SUNSET = "Mon, 10 Aug 2026 00:00:00 GMT";
  const WEBHOOK_LINK = '</api/v1/webhook-events>; rel="successor-version"';

  type V1Context = Context<{ Bindings: Env; Variables: AuthVariables }>;
  async function listWebhookEvents(c: V1Context) {
    const auth = c.get("auth");
    const { limit, beforeId } = parsePagination(c);
    const envelope = c.req.query("envelope") || undefined;
    const dispatchedAction = c.req.query("dispatched_action") || undefined;
    const signatureOkRaw = c.req.query("signature_ok");
    const dedupedRaw = c.req.query("deduped");
    const sinceTsRaw = c.req.query("since_ts");
    const sourceId = c.req.query("source_id") || undefined;

    const events = await new WebhookEventStore(c.env.DB).list({
      organizationId: auth.orgId,
      limit,
      envelope,
      dispatched_action: dispatchedAction,
      signatureOk:
        signatureOkRaw === undefined ? undefined : signatureOkRaw === "true",
      deduped:
        dedupedRaw === undefined ? undefined : dedupedRaw === "true",
      sinceTs:
        sinceTsRaw === undefined ? undefined : parseInt(sinceTsRaw, 10),
      sourceId,
      beforeId: beforeId ?? undefined,
    });
    const rows = events.map((e) => serializeWebhookEvent(e, /* truncate */ true));
    return c.json({
      webhook_events: rows,
      next_cursor:
        rows.length < limit
          ? null
          : (rows[rows.length - 1]?.id as string) ?? null,
    });
  }

  async function getWebhookEvent(c: V1Context) {
    const auth = c.get("auth");
    const id = c.req.param("id") ?? "";
    const row = await new WebhookEventStore(c.env.DB).get(id, auth.orgId);
    if (!row) return respondError(c, "not_found");
    return c.json({ webhook_event: serializeWebhookEvent(row, /* truncate */ false) });
  }

  app.get("/api/v1/webhook-events", listWebhookEvents);
  app.get("/api/v1/webhook-events/:id", getWebhookEvent);

  // Deprecated alias — same handlers, plus Sunset + Deprecation headers.
  // Response shape preserves the legacy `webhooks` / `webhook` keys so
  // existing dashboard code keeps working.
  app.get("/api/v1/webhooks", async (c) => {
    c.header("Sunset", WEBHOOK_SUNSET);
    c.header("Link", WEBHOOK_LINK);
    c.header("Deprecation", "true");
    const auth = c.get("auth");
    const limit = Math.min(parseIntOr(c.req.query("limit"), 50), 200);
    const envelope = c.req.query("envelope") || undefined;
    const dispatchedAction = c.req.query("dispatched_action") || undefined;
    const sourceId = c.req.query("source_id") || undefined;
    const events = await new WebhookEventStore(c.env.DB).list({
      organizationId: auth.orgId,
      limit,
      envelope,
      dispatched_action: dispatchedAction,
      sourceId,
    });
    return c.json({
      webhooks: events.map((e) => serializeWebhookEvent(e, /* truncate */ true)),
    });
  });

  app.get("/api/v1/webhooks/:id", async (c) => {
    c.header("Sunset", WEBHOOK_SUNSET);
    c.header("Link", WEBHOOK_LINK);
    c.header("Deprecation", "true");
    const auth = c.get("auth");
    const row = await new WebhookEventStore(c.env.DB).get(
      c.req.param("id"),
      auth.orgId,
    );
    if (!row) return respondError(c, "not_found");
    return c.json({ webhook: serializeWebhookEvent(row, /* truncate */ false) });
  });

  // ── Projects ────────────────────────────────────────────────────
  //
  // Strict create — no upsert. The dashboard handler keeps upsert
  // semantics for its UX flow. v1 returns 409 conflict when a project
  // already exists for the (org, linear_team_id) tuple.

  app.get("/api/v1/projects", async (c) => {
    const auth = c.get("auth");
    const projects = await new ProjectStore(c.env.DB).listByOrg(auth.orgId);
    return c.json({ projects });
  });

  app.post("/api/v1/projects", async (c) => {
    const auth = c.get("auth");
    const raw = await c.req.json().catch(() => null);
    const parsed = ProjectCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(
        c,
        "validation_failed",
        undefined,
        parsed.error.issues,
      );
    }
    const input = parsed.data;
    const store = new ProjectStore(c.env.DB);
    const existing = await store.getByTeamId(auth.orgId, input.linear_team_id);
    if (existing) {
      return respondError(
        c,
        "conflict",
        `A project for linear_team_id=${input.linear_team_id} already exists.`,
      );
    }
    const created = await store.create({
      organizationId: auth.orgId,
      linearTeamId: input.linear_team_id,
      linearTeamName: input.linear_team_name,
      repoUrl: input.repo_url,
      defaultBranch: input.default_branch,
      engine: input.engine,
      model: input.model ?? null,
      maxTurns: input.max_turns,
      scope: input.scope ?? null,
      systemPromptOverride: input.system_prompt_override ?? null,
    });
    if (!created) return respondError(c, "internal_error", "Insert failed.");
    return c.json({ project: created }, 201);
  });

  app.get("/api/v1/projects/:id", async (c) => {
    const auth = c.get("auth");
    const row = await new ProjectStore(c.env.DB).getById(
      c.req.param("id"),
      auth.orgId,
    );
    if (!row) return respondError(c, "not_found");
    return c.json({ project: row });
  });

  app.put("/api/v1/projects/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => null);
    const parsed = ProjectUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(
        c,
        "validation_failed",
        undefined,
        parsed.error.issues,
      );
    }
    const store = new ProjectStore(c.env.DB);
    const input = parsed.data;

    // Uniqueness re-check when linear_team_id is changing.
    if (input.linear_team_id !== undefined) {
      const conflict = await store.getByTeamId(auth.orgId, input.linear_team_id);
      if (conflict && conflict.id !== id) {
        return respondError(
          c,
          "conflict",
          `A project for linear_team_id=${input.linear_team_id} already exists.`,
        );
      }
    }

    const updated = await store.update(id, auth.orgId, {
      linearTeamId: input.linear_team_id,
      linearTeamName: input.linear_team_name,
      repoUrl: input.repo_url,
      defaultBranch: input.default_branch,
      engine: input.engine,
      model: input.model,
      maxTurns: input.max_turns,
      scope: input.scope,
      systemPromptOverride: input.system_prompt_override,
    });
    if (!updated) return respondError(c, "not_found");
    return c.json({ project: updated });
  });

  app.delete("/api/v1/projects/:id", async (c) => {
    const auth = c.get("auth");
    const removed = await new ProjectStore(c.env.DB).deleteById(
      c.req.param("id"),
      auth.orgId,
    );
    if (!removed) return respondError(c, "not_found");
    return c.json({ ok: true });
  });

  // ── Settings ────────────────────────────────────────────────────
  //
  // Free-form k/v: arbitrary keys are accepted (the Advanced UI uses
  // this). Curated runtime keys (agent.default_engine / .default_model
  // / .max_turns) get per-key validation via `validateSettingValue`.

  app.get("/api/v1/settings", async (c) => {
    const auth = c.get("auth");
    const settings = await new SettingStore(c.env.DB).list(auth.orgId);
    return c.json({
      settings,
      agent_defaults: buildAgentDefaults(c.env),
    });
  });

  app.get("/api/v1/settings/:key", async (c) => {
    const auth = c.get("auth");
    const key = c.req.param("key");
    const value = await new SettingStore(c.env.DB).get(auth.orgId, key);
    if (value === null) return respondError(c, "not_found");
    return c.json({ setting: { key, value } });
  });

  app.put("/api/v1/settings/:key", async (c) => {
    const auth = c.get("auth");
    const key = c.req.param("key");
    if (!key || key.length > 200) {
      return respondError(c, "validation_failed", "`key` must be 1-200 chars.");
    }
    const body = await c.req.json<{ value?: unknown }>().catch(() => null);
    if (!body || typeof body.value !== "string") {
      return respondError(c, "validation_failed", "Body must be `{ value: <string> }`.");
    }
    const violation = validateSettingValue(key, body.value);
    if (violation) return respondError(c, "validation_failed", violation);
    await new SettingStore(c.env.DB).upsert(auth.orgId, key, body.value);
    return c.json({ setting: { key, value: body.value } });
  });

  app.delete("/api/v1/settings/:key", async (c) => {
    const auth = c.get("auth");
    const removed = await new SettingStore(c.env.DB).delete(
      auth.orgId,
      c.req.param("key"),
    );
    if (!removed) return respondError(c, "not_found");
    return c.json({ ok: true });
  });

  // ── Integrations (read-only) ────────────────────────────────────
  //
  // Connect / disconnect flows stay on /oauth/* and /dashboard/api/*
  // because OAuth callbacks need a session cookie. MCP and CI clients
  // can still inspect what's connected.

  app.get("/api/v1/integrations", async (c) => {
    const auth = c.get("auth");
    const orgId = auth.orgId;
    const install = await new LinearAgentInstallStore(c.env.DB).getByOrgId(orgId);
    const github = await new GitHubInstallStore(c.env.DB).getByOrgId(orgId);
    const configuredKinds = await new CredentialStore(c.env.DB).listKinds(orgId);
    const configuredSet = new Set(configuredKinds);
    return c.json({
      linear: { connected: !!install },
      github: {
        connected: !!github,
        repo_selection: github?.repo_selection ?? null,
        repo_count: github
          ? github.repo_selection === "all"
            ? null
            : github.selected_repos
              ? (JSON.parse(github.selected_repos) as unknown[]).length
              : 0
          : 0,
      },
      anthropic: { configured: configuredSet.has("anthropic") },
      openai: { configured: configuredSet.has("openai") },
      cf_workers_ai: { configured: configuredSet.has("cf_workers_ai") },
      github_app_settings_url: c.env.GITHUB_APP_SETTINGS_URL ?? null,
    });
  });

  // ── API tokens ──────────────────────────────────────────────────
  //
  // Plaintext format: `tok_<43 char base64url>` (32 random bytes).
  // Plaintext is only returned on the create response — only the
  // SHA-256 hash is persisted, so a lost token cannot be recovered;
  // revoke + reissue is the recovery path.

  app.get("/api/v1/api-tokens", async (c) => {
    const denied = requireScope(c, "read");
    if (denied) return denied;
    const auth = c.get("auth");
    const result = await c.env.DB.prepare(
      `SELECT id, name, scopes, created_at, last_used_at
       FROM api_tokens
       WHERE organization_id = ?
       ORDER BY created_at DESC`,
    )
      .bind(auth.orgId)
      .all<{
        id: string;
        name: string;
        scopes: string | null;
        created_at: number;
        last_used_at: number | null;
      }>();
    const tokens = (result.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      scopes: parseScopes(row.scopes),
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    }));
    return c.json({ tokens });
  });

  app.post("/api/v1/api-tokens", async (c) => {
    const denied = requireScope(c, "admin");
    if (denied) return denied;
    const auth = c.get("auth");
    const raw = await c.req.json().catch(() => null);
    const parsed = ApiTokenCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return respondError(
        c,
        "validation_failed",
        undefined,
        parsed.error.issues,
      );
    }
    const { name, scopes } = parsed.data;
    const plaintext = generateTokenPlaintext();
    const hash = await hashToken(plaintext);
    const id = crypto.randomUUID();
    const ts = nowSec();

    await c.env.DB.prepare(
      `INSERT INTO api_tokens (id, organization_id, name, token_hash, scopes, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(id, auth.orgId, name, hash, JSON.stringify(scopes), ts)
      .run();

    return c.json(
      {
        token: {
          id,
          name,
          scopes,
          created_at: ts,
          last_used_at: null,
          plaintext,
        },
      },
      201,
    );
  });

  app.delete("/api/v1/api-tokens/:id", async (c) => {
    const denied = requireScope(c, "admin");
    if (denied) return denied;
    const auth = c.get("auth");
    const res = await c.env.DB.prepare(
      "DELETE FROM api_tokens WHERE id = ? AND organization_id = ?",
    )
      .bind(c.req.param("id"), auth.orgId)
      .run();
    if ((res.meta?.changes ?? 0) === 0) return respondError(c, "not_found");
    return c.json({ ok: true });
  });

  return app;
}

function parseScopes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

// 32 random bytes → 43-char base64url (no padding), prefixed with
// `tok_` so leaked tokens are easy to grep for in logs and source.
function generateTokenPlaintext(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return (
    "tok_" +
    btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

// Compose a candidate EventTuple from /resolve query params. Each
// event_type variant has its own required fields; we read them from
// the query string and let Zod fail the request when something's
// missing.
function buildResolveEvent(
  eventType: string,
  orgId: string,
  issueId: string | undefined,
  c: { req: { query(name: string): string | undefined } },
): Record<string, unknown> | null {
  const base = {
    event_type: eventType,
    organization_id: orgId,
    issue: issueId ? { id: issueId, labels: [], comments: [] } : null,
    labels: [],
  };
  switch (eventType) {
    case "session_started":
      return base;
    case "state_entered":
      return { ...base, to_state: c.req.query("to_state") ?? "" };
    case "state_exited":
      return { ...base, from_state: c.req.query("from_state") ?? "" };
    case "comment_added":
      return { ...base, comment: c.req.query("comment") ?? "" };
    case "label_added":
    case "label_removed":
      return { ...base, label_name: c.req.query("label_name") ?? "" };
    case "assignee_changed":
      return {
        ...base,
        to_assignee_id: c.req.query("to_assignee_id") ?? null,
        from_assignee_id: c.req.query("from_assignee_id") ?? null,
      };
    default:
      return null;
  }
}

async function getWorkflow(
  db: D1Database,
  id: string,
  orgId: string,
): Promise<WorkflowRow | null> {
  return await db
    .prepare(
      `SELECT ${WORKFLOW_COLS} FROM workflows
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, orgId)
    .first<WorkflowRow>();
}

async function getTrigger(
  db: D1Database,
  id: string,
): Promise<TriggerRow | null> {
  return await db
    .prepare(`SELECT ${TRIGGER_COLS} FROM workflow_triggers WHERE id = ?`)
    .bind(id)
    .first<TriggerRow>();
}

function hydrateWorkflowFromRow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    organization_id: row.organization_id,
    team_id: row.team_id,
    user_id: row.user_id,
    name: row.name,
    description: row.description,
    engine: row.engine,
    model: row.model,
    max_turns: row.max_turns,
    max_continuations: row.max_continuations,
    allowed_tools: asJsonArray(row.allowed_tools) as string[] | null,
    disallowed_tools: asJsonArray(row.disallowed_tools) as string[] | null,
    allowed_domains: asJsonArray(row.allowed_domains) as string[] | null,
    mcp_servers: asJsonArray(row.mcp_servers) as Workflow["mcp_servers"],
    permission_mode: row.permission_mode,
    additional_read_paths: asJsonArray(row.additional_read_paths) as string[] | null,
    additional_write_paths: asJsonArray(row.additional_write_paths) as string[] | null,
    hook_after_create: row.hook_after_create,
    hook_before_remove: row.hook_before_remove,
    hook_timeout_ms: row.hook_timeout_ms,
    prompt_template: row.prompt_template,
    version: row.version,
    status: row.status as Workflow["status"],
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateTriggerFromRow(row: TriggerRow): Trigger {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    event_type: row.event_type as Trigger["event_type"],
    to_state: row.to_state,
    from_state: row.from_state,
    label_name: row.label_name,
    comment_match: row.comment_match,
    team_filter: asJsonArray(row.team_filter) as string[] | null,
    project_filter: asJsonArray(row.project_filter) as string[] | null,
    label_filter: asJsonArray(row.label_filter) as string[] | null,
    skip_label_filter: asJsonArray(row.skip_label_filter) as string[] | null,
    assignee_filter: asJsonArray(row.assignee_filter) as string[] | null,
    action: row.action as Trigger["action"],
    action_params: asJsonObject(row.action_params),
    priority: row.priority,
    enabled: row.enabled !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getTriggerAndWorkflow(
  db: D1Database,
  triggerId: string,
  orgId: string,
): Promise<{ trigger: Trigger; workflow: Workflow } | null> {
  const triggerRow = await getTriggerWithOrg(db, triggerId, orgId);
  if (!triggerRow) return null;
  const workflowRow = await getWorkflow(db, triggerRow.workflow_id, orgId);
  if (!workflowRow) return null;
  return {
    trigger: hydrateTriggerFromRow(triggerRow),
    workflow: hydrateWorkflowFromRow(workflowRow),
  };
}

// Trigger ↔ org enforcement: a caller can only operate on triggers
// whose workflow belongs to their organization. SQLite has no row-
// level security, so we join-filter explicitly.
async function getTriggerWithOrg(
  db: D1Database,
  id: string,
  orgId: string,
): Promise<TriggerRow | null> {
  return await db
    .prepare(
      `SELECT ${TRIGGER_COLS.split(", ")
        .map((c) => `t.${c}`)
        .join(", ")}
       FROM workflow_triggers t
       JOIN workflows w ON w.id = t.workflow_id
       WHERE t.id = ? AND w.organization_id = ?`,
    )
    .bind(id, orgId)
    .first<TriggerRow>();
}
