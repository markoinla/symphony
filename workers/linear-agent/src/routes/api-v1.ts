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
import { Hono } from "hono";

import type { Env } from "../index";
import type { AuthVariables } from "../lib/auth/context";
import { requireAuth } from "../lib/auth/context";
import { resolveWorkflow } from "../lib/workflows/resolver";
import { renderPrompt } from "../lib/workflows/render";
import type { WorkflowConfigSubset } from "../workflows/session-runner";
import {
  TriggerCreateSchema,
  TriggerUpdateSchema,
} from "../schemas/trigger";
import { eventTupleSchema } from "../schemas/event";
import {
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
  "id, workflow_id, event_type, to_state, from_state, label_name, comment_match, team_filter, project_filter, label_filter, skip_label_filter, assignee_filter, action, action_params, priority, enabled, created_at, updated_at";

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
    action: row.action,
    action_params: asJsonObject(row.action_params),
    priority: row.priority,
    enabled: row.enabled !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Body schema for `/preview` — Track 1's workflow schemas don't include
// this since it's API-layer-only.
const PreviewRequestSchema = z.object({
  issue_id: z.string().min(1),
});

// Body schema for `/test-run` — issue_id and prompt are both optional;
// omitting issue_id synthesises a throwaway session id so callers can
// exercise the dispatch path without a real Linear issue.
const TestRunRequestSchema = z.object({
  issue_id: z.string().min(1).optional(),
  prompt: z.string().optional(),
});

// ────────────────────────────────────────────────────────────────────
// Router
// ────────────────────────────────────────────────────────────────────

export function buildApiV1Router() {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  // All /api/v1/* routes require a valid AuthContext.
  app.use("/api/v1/*", requireAuth());

  // ── Workflows ────────────────────────────────────────────────────

  app.get("/api/v1/workflows", async (c) => {
    const auth = c.get("auth");
    const result = await c.env.DB.prepare(
      `SELECT ${WORKFLOW_COLS} FROM workflows
       WHERE organization_id = ?
       ORDER BY created_at DESC`,
    )
      .bind(auth.orgId)
      .all<WorkflowRow>();
    return c.json({
      workflows: (result.results ?? []).map(serializeWorkflow),
    });
  });

  app.post("/api/v1/workflows", async (c) => {
    const auth = c.get("auth");
    const raw = await c.req.json().catch(() => null);
    const parsed = WorkflowCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", issues: parsed.error.issues },
        400,
      );
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
    if (!row) return c.json({ error: "insert_failed" }, 500);
    return c.json({ workflow: serializeWorkflow(row) }, 201);
  });

  app.get("/api/v1/workflows/:id", async (c) => {
    const auth = c.get("auth");
    const row = await getWorkflow(c.env.DB, c.req.param("id"), auth.orgId);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ workflow: serializeWorkflow(row) });
  });

  app.put("/api/v1/workflows/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => null);
    const parsed = WorkflowUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", issues: parsed.error.issues },
        400,
      );
    }
    const input = parsed.data;

    const existing = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!existing) return c.json({ error: "not_found" }, 404);

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
    if (!updated) return c.json({ error: "not_found" }, 404);
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
      return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  // ── Publish — snapshot row + flip status ─────────────────────────

  app.post("/api/v1/workflows/:id/publish", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const existing = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!existing) return c.json({ error: "not_found" }, 404);

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
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({
      workflow: serializeWorkflow(updated),
      version: { id: versionId, version, created_at: ts },
    });
  });

  // ── Duplicate ────────────────────────────────────────────────────

  app.post("/api/v1/workflows/:id/duplicate", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const src = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!src) return c.json({ error: "not_found" }, 404);

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
    if (!row) return c.json({ error: "duplicate_failed" }, 500);
    return c.json({ workflow: serializeWorkflow(row) }, 201);
  });

  // ── Preview — render the prompt template against an issue ───────

  app.post("/api/v1/workflows/:id/preview", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => null);
    const parsed = PreviewRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", issues: parsed.error.issues },
        400,
      );
    }

    const row = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!row) return c.json({ error: "not_found" }, 404);

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

  // ── Test-run — dispatch a real SESSION_RUNNER instance ──────────
  //
  // Synthesises an AgentSessionEventWebhook carrying the workflow's
  // config so the session-runner uses it instead of the legacy project
  // columns. This is the same path `dispatchAction` uses when a live
  // trigger fires — the only difference is the caller rather than a
  // Linear webhook.
  //
  // Prerequisites for a run to complete end-to-end:
  //   - A per-engine baseline must be registered in the
  //     sandbox-dispatcher (it returns 412 otherwise).
  //   - The org must have a project row with a repo_url for the team
  //     referenced by issue_id, or the runner exits with "no_repo".

  app.post("/api/v1/workflows/:id/test-run", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const row = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!row) return c.json({ error: "not_found" }, 404);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = TestRunRequestSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", issues: parsed.error.issues },
        400,
      );
    }

    const issueId = parsed.data.issue_id ?? `test:${id}`;
    const instanceId = `${auth.orgId}:${issueId}:test:${Date.now()}`;

    const workflowConfig: WorkflowConfigSubset = {
      id: row.id,
      engine: row.engine,
      model: row.model,
      max_turns: row.max_turns,
      max_continuations: row.max_continuations,
      prompt_template: row.prompt_template,
      allowed_tools: asJsonArray(row.allowed_tools) as string[] | null,
      disallowed_tools: asJsonArray(row.disallowed_tools) as string[] | null,
      permission_mode: row.permission_mode,
      allowed_domains: asJsonArray(row.allowed_domains) as string[] | null,
      additional_read_paths:
        asJsonArray(row.additional_read_paths) as string[] | null,
      additional_write_paths:
        asJsonArray(row.additional_write_paths) as string[] | null,
      hook_after_create: row.hook_after_create,
      hook_before_remove: row.hook_before_remove,
      hook_timeout_ms: row.hook_timeout_ms,
      mcp_servers:
        asJsonArray(row.mcp_servers) as WorkflowConfigSubset["mcp_servers"],
    };

    const syntheticEvent = {
      type: "AgentSessionEvent" as const,
      action: "created" as const,
      webhookId: `test-run:${instanceId}`,
      organizationId: auth.orgId,
      agentSession: {
        id: instanceId,
        ...(parsed.data.issue_id
          ? {
              issue: {
                id: parsed.data.issue_id,
                identifier: parsed.data.issue_id,
                title: `Test run for workflow "${row.name}"`,
              },
            }
          : {}),
        promptContext:
          parsed.data.prompt ?? `Test run for workflow "${row.name}"`,
      },
    };

    try {
      await c.env.SESSION_RUNNER.create({
        id: instanceId,
        params: { event: syntheticEvent, workflowConfig },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/instance.*exists|already/i.test(msg)) {
        return c.json({ error: "dispatch_failed", message: msg }, 502);
      }
      // Instance already running — treat as success (idempotent).
    }

    return c.json({ ok: true, instance_id: instanceId });
  });

  // ── Resolve — debug helper ──────────────────────────────────────

  app.get("/api/v1/workflows/resolve", async (c) => {
    const auth = c.get("auth");
    const eventType = c.req.query("event_type");
    const issueId = c.req.query("issue_id");
    if (!eventType) return c.json({ error: "missing_event_type" }, 400);

    // The shared eventTupleSchema is a discriminated union; build the
    // shape variant-by-variant. The debug helper supports the simple
    // forms — state_entered, comment_added, etc.
    const candidate = buildResolveEvent(eventType, auth.orgId, issueId, c);
    if (!candidate) return c.json({ error: "unsupported_event_type" }, 400);
    const parsed = eventTupleSchema.safeParse(candidate);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_event", issues: parsed.error.issues },
        400,
      );
    }
    const result = await resolveWorkflow(c.env, parsed.data);
    return c.json({ result });
  });

  // ── Triggers ────────────────────────────────────────────────────

  app.get("/api/v1/workflows/:id/triggers", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const workflow = await getWorkflow(c.env.DB, id, auth.orgId);
    if (!workflow) return c.json({ error: "not_found" }, 404);

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
    if (!workflow) return c.json({ error: "not_found" }, 404);

    const raw = await c.req.json().catch(() => null);
    const parsed = TriggerCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", issues: parsed.error.issues },
        400,
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
         action, action_params, priority, enabled, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        t.action,
        jsonOrNull(t.action_params),
        t.priority,
        t.enabled ? 1 : 0,
        ts,
        ts,
      )
      .run();

    const row = await getTrigger(c.env.DB, triggerId);
    if (!row) return c.json({ error: "insert_failed" }, 500);
    return c.json({ trigger: serializeTrigger(row) }, 201);
  });

  app.get("/api/v1/triggers/:id", async (c) => {
    const auth = c.get("auth");
    const row = await getTriggerWithOrg(c.env.DB, c.req.param("id"), auth.orgId);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ trigger: serializeTrigger(row) });
  });

  app.put("/api/v1/triggers/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const existing = await getTriggerWithOrg(c.env.DB, id, auth.orgId);
    if (!existing) return c.json({ error: "not_found" }, 404);

    const raw = await c.req.json().catch(() => null);
    const parsed = TriggerUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", issues: parsed.error.issues },
        400,
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
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({ trigger: serializeTrigger(updated) });
  });

  app.delete("/api/v1/triggers/:id", async (c) => {
    const auth = c.get("auth");
    const existing = await getTriggerWithOrg(c.env.DB, c.req.param("id"), auth.orgId);
    if (!existing) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("DELETE FROM workflow_triggers WHERE id = ?")
      .bind(existing.id)
      .run();
    return c.json({ ok: true });
  });

  return app;
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
