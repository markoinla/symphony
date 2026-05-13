// MCP (Model Context Protocol) transport for /api/v1.
//
// Spec: https://modelcontextprotocol.io/
// Transport: Streamable HTTP (POST /mcp). SSE notifications aren't
// needed for our tool surface — every operation is request/response.
//
// All tools dispatch into the v1 REST handlers via a synthetic Request
// against an internally-instantiated v1 router. This guarantees that
// validation, scope enforcement, persistence, and error envelopes
// match the REST surface exactly — there is no parallel implementation
// to drift.
//
// Auth: bearer-only. The original Authorization header is forwarded
// to the internal Request unchanged, so token scope governs which
// tools are usable. The cookie path is rejected because MCP clients
// don't carry browser cookies.
//
// Workflow surface: the MCP server intentionally exposes the *same*
// subset of workflow fields that the dashboard editor surfaces. The
// "hidden" columns (allowed_tools, mcp_servers, hook_*, permission_mode,
// allowed_domains, additional_*_paths, max_continuations) aren't wired
// through to the dispatcher / engine layer yet, so the editor hides
// them and the MCP tools mirror that. See workflow-editor/index.tsx
// for the canonical list.

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../index";
import { extractBearer } from "../lib/auth/bearer";
import { respondError } from "../lib/responses";
import { ApiTokenCreateSchema } from "../schemas/api-token";
import {
  ProjectCreateSchema,
  ProjectSchema,
  ProjectUpdateSchema,
} from "../schemas/project";
import {
  TriggerCreateSchema,
  TriggerSchema,
  TriggerUpdateSchema,
} from "../schemas/trigger";
import {
  WorkflowCreateSchema,
  WorkflowUpdateSchema,
  workflowStatusSchema,
  engineSchema,
} from "../schemas/workflow";
import { buildApiV1Router } from "./api-v1";

// ────────────────────────────────────────────────────────────────────
// Protocol versions we speak. Ordered newest first. If the client
// requests a version we support we echo it back; otherwise we send our
// newest and let the client decide.
// ────────────────────────────────────────────────────────────────────
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// JSON-RPC 2.0 wire types.
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// JSON-RPC error codes per the MCP spec.
const ERR = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Application-level — anything ≥ -32000 is per-server. We map REST
  // failures into ToolError so downstream agents can branch on `code`.
  ToolError: -32000,
} as const;

type Scope = "read" | "write" | "admin";

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface Tool {
  name: string;
  description: string;
  scope: Scope;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  // Dispatch an MCP `tools/call` invocation into the v1 REST surface.
  // Returns the JSON body (object) plus the response status so the
  // MCP envelope can carry both.
  dispatch: (args: Record<string, unknown>, ctx: DispatchCtx) => Promise<DispatchResult>;
  // Optional projector applied to the v1 response body before it's
  // surfaced as structuredContent. Used to strip workflow columns that
  // aren't part of the user-visible surface.
  projectResult?: (body: unknown) => unknown;
}

interface DispatchCtx {
  env: Env;
  exec: ExecutionContext;
  authorization: string; // raw header value (`Bearer …`)
}

interface DispatchResult {
  status: number;
  body: unknown;
}

// One v1 router instance per Worker invocation. Hono routers are cheap
// to construct, but instantiating once at module top is even cheaper.
const internalV1 = buildApiV1Router();

async function callV1(
  method: string,
  path: string,
  body: unknown,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  const headers: Record<string, string> = {
    Authorization: ctx.authorization,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const req = new Request(`https://internal.local${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await internalV1.fetch(req, ctx.env, ctx.exec);
  let parsed: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

// Path-segment helper. Tool arg names are kebab-cased in the URL.
function encId(v: unknown): string {
  return encodeURIComponent(String(v));
}

// Query-string helper for list endpoints. Drops undefined values.
function qs(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s.length > 0 ? `?${s}` : "";
}

// ────────────────────────────────────────────────────────────────────
// MCP-visible workflow projection. Inputs and outputs both clip to
// the fields the dashboard editor exposes. Hidden columns round-trip
// untouched on update (the v1 partial-update treats absent fields as
// "leave alone") and are stripped from responses before the agent sees
// them.
// ────────────────────────────────────────────────────────────────────

const McpWorkflowCreateSchema = WorkflowCreateSchema.pick({
  name: true,
  description: true,
  engine: true,
  model: true,
  max_turns: true,
  prompt_template: true,
});

const McpWorkflowUpdateSchema = WorkflowUpdateSchema.pick({
  name: true,
  description: true,
  engine: true,
  model: true,
  max_turns: true,
  prompt_template: true,
});

const McpWorkflowSchema = z.object({
  id: z.string(),
  organization_id: z.string().nullable(),
  team_id: z.string().nullable(),
  user_id: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable().optional(),
  engine: engineSchema,
  model: z.string().nullable().optional(),
  max_turns: z.number().int().positive(),
  prompt_template: z.string(),
  version: z.number().int().positive(),
  status: workflowStatusSchema,
  published_at: z.number().int().nullable().optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

const WORKFLOW_VISIBLE_KEYS = Object.keys(
  McpWorkflowSchema.shape,
) as Array<keyof z.infer<typeof McpWorkflowSchema>>;

function projectWorkflowRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const src = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of WORKFLOW_VISIBLE_KEYS) {
    if (k in src) out[k] = src[k];
  }
  return out;
}

// Applied to every workflow tool's response. Handles the three shapes
// the v1 surface returns: `{ workflow }`, `{ workflows: [...] }`, and
// publish's `{ workflow, version }`.
function projectWorkflowResponse(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const src = body as Record<string, unknown>;
  // Error envelopes pass through unchanged so the agent sees the
  // real `error`/`message` fields.
  if (typeof src.error === "string") return body;
  const out: Record<string, unknown> = { ...src };
  if (src.workflow && typeof src.workflow === "object") {
    out.workflow = projectWorkflowRow(src.workflow);
  }
  if (Array.isArray(src.workflows)) {
    out.workflows = src.workflows.map(projectWorkflowRow);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Output schemas. Reused across tools so we only convert once. These
// reflect the structuredContent the client will see on success — on
// errors `isError: true` is set and the schema is best-effort.
// ────────────────────────────────────────────────────────────────────

const NextCursor = z.string().nullable();

const McpWorkflowListResponseSchema = z.toJSONSchema(
  z.object({
    workflows: z.array(McpWorkflowSchema),
    next_cursor: NextCursor,
  }),
);
const McpWorkflowSingleResponseSchema = z.toJSONSchema(
  z.object({ workflow: McpWorkflowSchema }),
);
const McpWorkflowPublishResponseSchema = z.toJSONSchema(
  z.object({
    workflow: McpWorkflowSchema,
    version: z.object({
      id: z.string(),
      version: z.number().int().positive(),
      created_at: z.number().int(),
    }),
  }),
);

// ────────────────────────────────────────────────────────────────────
// Tool registry — 1:1 with the v1 routes per docs/linear_agent_api_v1.md.
// Token CRUD is intentionally absent: agents shouldn't issue agent
// credentials.
// ────────────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "workflows.list",
    description:
      "List workflows in the calling token's organization. Cursor paginated — pass the returned `next_cursor` as `before_id` to fetch the next page. Filter by `status` (draft / published / archived). Returns the user-visible workflow shape only; the dashboard editor exposes the same fields.",
    scope: "read",
    annotations: {
      title: "List workflows",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        before_id: {
          type: "string",
          description: "Pagination cursor — typically the `next_cursor` from a prior call.",
        },
        status: {
          type: "string",
          enum: ["draft", "published", "archived"],
        },
      },
    },
    outputSchema: McpWorkflowListResponseSchema,
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/workflows${qs(args)}`, undefined, ctx),
    projectResult: projectWorkflowResponse,
  },
  {
    name: "workflows.get",
    description:
      "Fetch a single workflow by id. Returns the user-visible field set. Errors: 404 if the workflow doesn't exist or isn't owned by the calling org.",
    scope: "read",
    annotations: {
      title: "Get workflow",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", description: "Workflow UUID." } },
    },
    outputSchema: McpWorkflowSingleResponseSchema,
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/workflows/${encId(args.id)}`, undefined, ctx),
    projectResult: projectWorkflowResponse,
  },
  {
    name: "workflows.create",
    description:
      "Create a new draft workflow scoped to the calling token's organization. Only the user-visible fields are accepted: `name`, `description`, `engine`, `model`, `max_turns`, `prompt_template`. Hidden sandbox / hook columns are not yet wired through the engine and cannot be set from this surface. Returns the created workflow (status `draft`, version `1`).",
    scope: "write",
    annotations: {
      title: "Create workflow",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.toJSONSchema(McpWorkflowCreateSchema),
    outputSchema: McpWorkflowSingleResponseSchema,
    dispatch: (args, ctx) => callV1("POST", "/api/v1/workflows", args, ctx),
    projectResult: projectWorkflowResponse,
  },
  {
    name: "workflows.update",
    description:
      "Partially update a workflow. Only the user-visible fields can be patched (`name`, `description`, `engine`, `model`, `max_turns`, `prompt_template`); omitted fields are unchanged. Published workflows are immutable — duplicate first if you need to edit one. Errors: 404 if not found, 409 if the workflow is not in `draft` status.",
    scope: "write",
    annotations: {
      title: "Update workflow",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Workflow UUID." },
        patch: z.toJSONSchema(McpWorkflowUpdateSchema),
      },
    },
    outputSchema: McpWorkflowSingleResponseSchema,
    dispatch: (args, ctx) =>
      callV1(
        "PUT",
        `/api/v1/workflows/${encId(args.id)}`,
        (args.patch ?? {}) as Record<string, unknown>,
        ctx,
      ),
    projectResult: projectWorkflowResponse,
  },
  {
    name: "workflows.delete",
    description:
      "Delete a workflow. This cascades to its triggers but does not delete historical agent sessions that were spawned from it. Irreversible.",
    scope: "write",
    annotations: {
      title: "Delete workflow",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", description: "Workflow UUID." } },
    },
    dispatch: (args, ctx) =>
      callV1("DELETE", `/api/v1/workflows/${encId(args.id)}`, undefined, ctx),
    projectResult: projectWorkflowResponse,
  },
  {
    name: "workflows.publish",
    description:
      "Snapshot a draft workflow and flip its status to `published`. The version number increments. Once published, the workflow is immutable — further edits require `workflows.duplicate` to get a new draft. Returns the published workflow plus the snapshot metadata.",
    scope: "write",
    annotations: {
      title: "Publish workflow",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", description: "Workflow UUID." } },
    },
    outputSchema: McpWorkflowPublishResponseSchema,
    dispatch: (args, ctx) =>
      callV1("POST", `/api/v1/workflows/${encId(args.id)}/publish`, undefined, ctx),
    projectResult: projectWorkflowResponse,
  },
  {
    name: "workflows.duplicate",
    description:
      "Clone an existing workflow into a new draft. Triggers are NOT copied — the new workflow starts with no triggers attached. Use this to fork a published workflow when you need to edit it.",
    scope: "write",
    annotations: {
      title: "Duplicate workflow",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", description: "Source workflow UUID." } },
    },
    outputSchema: McpWorkflowSingleResponseSchema,
    dispatch: (args, ctx) =>
      callV1("POST", `/api/v1/workflows/${encId(args.id)}/duplicate`, undefined, ctx),
    projectResult: projectWorkflowResponse,
  },
  {
    name: "workflows.preview",
    description:
      "Render a workflow's prompt template against a specific Linear issue. Useful for debugging template variables before publishing. The issue must be accessible to the org's connected Linear workspace.",
    scope: "read",
    annotations: {
      title: "Preview workflow prompt",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id", "issue_id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Workflow UUID." },
        issue_id: {
          type: "string",
          description: "Linear issue UUID or identifier (e.g. `SYM-123`).",
        },
      },
    },
    dispatch: (args, ctx) =>
      callV1(
        "POST",
        `/api/v1/workflows/${encId(args.id)}/preview`,
        { issue_id: args.issue_id },
        ctx,
      ),
  },
  {
    name: "triggers.list",
    description:
      "List the triggers attached to a workflow. Triggers map Linear webhook events (issue.created, comment, etc.) to dispatched actions.",
    scope: "read",
    annotations: {
      title: "List triggers",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["workflow_id"],
      additionalProperties: false,
      properties: { workflow_id: { type: "string", description: "Parent workflow UUID." } },
    },
    outputSchema: z.toJSONSchema(
      z.object({ triggers: z.array(TriggerSchema) }),
    ),
    dispatch: (args, ctx) =>
      callV1(
        "GET",
        `/api/v1/workflows/${encId(args.workflow_id)}/triggers`,
        undefined,
        ctx,
      ),
  },
  {
    name: "triggers.create",
    description:
      "Attach a new trigger to a workflow. Returns 404 if the workflow doesn't exist.",
    scope: "write",
    annotations: {
      title: "Create trigger",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["workflow_id", "trigger"],
      additionalProperties: false,
      properties: {
        workflow_id: { type: "string", description: "Parent workflow UUID." },
        trigger: z.toJSONSchema(TriggerCreateSchema),
      },
    },
    outputSchema: z.toJSONSchema(z.object({ trigger: TriggerSchema })),
    dispatch: (args, ctx) =>
      callV1(
        "POST",
        `/api/v1/workflows/${encId(args.workflow_id)}/triggers`,
        args.trigger,
        ctx,
      ),
  },
  {
    name: "triggers.get",
    description: "Fetch a single trigger by id.",
    scope: "read",
    annotations: {
      title: "Get trigger",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", description: "Trigger UUID." } },
    },
    outputSchema: z.toJSONSchema(z.object({ trigger: TriggerSchema })),
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/triggers/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "triggers.update",
    description:
      "Partially update a trigger. Omitted fields are unchanged. Errors: 404 if not found.",
    scope: "write",
    annotations: {
      title: "Update trigger",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Trigger UUID." },
        patch: z.toJSONSchema(TriggerUpdateSchema),
      },
    },
    outputSchema: z.toJSONSchema(z.object({ trigger: TriggerSchema })),
    dispatch: (args, ctx) =>
      callV1(
        "PUT",
        `/api/v1/triggers/${encId(args.id)}`,
        (args.patch ?? {}) as Record<string, unknown>,
        ctx,
      ),
  },
  {
    name: "triggers.delete",
    description: "Delete a trigger. Irreversible.",
    scope: "write",
    annotations: {
      title: "Delete trigger",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", description: "Trigger UUID." } },
    },
    dispatch: (args, ctx) =>
      callV1("DELETE", `/api/v1/triggers/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "projects.list",
    description:
      "List projects in the calling token's organization. A project pairs a Symphony workspace with a Linear team.",
    scope: "read",
    annotations: {
      title: "List projects",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: z.toJSONSchema(z.object({ projects: z.array(ProjectSchema) })),
    dispatch: (_args, ctx) => callV1("GET", "/api/v1/projects", undefined, ctx),
  },
  {
    name: "projects.get",
    description: "Fetch a single project by id.",
    scope: "read",
    annotations: {
      title: "Get project",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", description: "Project UUID." } },
    },
    outputSchema: z.toJSONSchema(z.object({ project: ProjectSchema })),
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/projects/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "projects.create",
    description:
      "Create a new project. Returns 409 if a project with the same (organization, linear_team_id) pair already exists — projects are unique per Linear team within an org.",
    scope: "write",
    annotations: {
      title: "Create project",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.toJSONSchema(ProjectCreateSchema),
    outputSchema: z.toJSONSchema(z.object({ project: ProjectSchema })),
    dispatch: (args, ctx) => callV1("POST", "/api/v1/projects", args, ctx),
  },
  {
    name: "projects.update",
    description: "Partially update a project. Omitted fields are unchanged.",
    scope: "write",
    annotations: {
      title: "Update project",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Project UUID." },
        patch: z.toJSONSchema(ProjectUpdateSchema),
      },
    },
    outputSchema: z.toJSONSchema(z.object({ project: ProjectSchema })),
    dispatch: (args, ctx) =>
      callV1(
        "PUT",
        `/api/v1/projects/${encId(args.id)}`,
        (args.patch ?? {}) as Record<string, unknown>,
        ctx,
      ),
  },
  {
    name: "projects.delete",
    description:
      "Delete a project. Workflows and triggers under it survive — only the org↔Linear-team binding is removed.",
    scope: "write",
    annotations: {
      title: "Delete project",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", description: "Project UUID." } },
    },
    dispatch: (args, ctx) =>
      callV1("DELETE", `/api/v1/projects/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "settings.list",
    description:
      "List per-org settings overrides plus the `agent_defaults` payload that backs unset values.",
    scope: "read",
    annotations: {
      title: "List settings",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: { type: "object", additionalProperties: false },
    dispatch: (_args, ctx) => callV1("GET", "/api/v1/settings", undefined, ctx),
  },
  {
    name: "settings.get",
    description: "Fetch a single setting by key. Returns 404 if unset.",
    scope: "read",
    annotations: {
      title: "Get setting",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["key"],
      additionalProperties: false,
      properties: { key: { type: "string", description: "Setting key (e.g. `agent.default_model`)." } },
    },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/settings/${encId(args.key)}`, undefined, ctx),
  },
  {
    name: "settings.set",
    description:
      "Upsert a setting. Both `key` and `value` are strings; structured values must be JSON-encoded.",
    scope: "write",
    annotations: {
      title: "Set setting",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["key", "value"],
      additionalProperties: false,
      properties: {
        key: { type: "string", description: "Setting key." },
        value: { type: "string", description: "Setting value — encode JSON as a string if structured." },
      },
    },
    dispatch: (args, ctx) =>
      callV1(
        "PUT",
        `/api/v1/settings/${encId(args.key)}`,
        { value: args.value },
        ctx,
      ),
  },
  {
    name: "settings.delete",
    description: "Delete a setting key, reverting the org to the default value.",
    scope: "write",
    annotations: {
      title: "Delete setting",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["key"],
      additionalProperties: false,
      properties: { key: { type: "string", description: "Setting key." } },
    },
    dispatch: (args, ctx) =>
      callV1("DELETE", `/api/v1/settings/${encId(args.key)}`, undefined, ctx),
  },
  {
    name: "integrations.status",
    description:
      "Connection-status payload for every supported provider (Linear, GitHub App, Anthropic, OpenAI, Cloudflare Workers AI). Read-only.",
    scope: "read",
    annotations: {
      title: "Integration status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: { type: "object", additionalProperties: false },
    dispatch: (_args, ctx) =>
      callV1("GET", "/api/v1/integrations", undefined, ctx),
  },
  {
    name: "webhook_events.list",
    description:
      "List inbound webhook deliveries from Linear. Cursor paginated — pass `next_cursor` as `before_id`. Filter by `envelope`, `dispatched_action`, signature verification result, or dedup status. Useful for debugging missed triggers.",
    scope: "read",
    annotations: {
      title: "List webhook events",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        before_id: { type: "string", description: "Pagination cursor." },
        envelope: {
          type: "string",
          description: "Filter by envelope type (e.g. `Issue`, `Comment`).",
        },
        dispatched_action: {
          type: "string",
          description: "Filter by the action the agent dispatched.",
        },
        signature_ok: { type: "boolean" },
        deduped: { type: "boolean" },
        since_ts: {
          type: "integer",
          description: "Unix seconds — return only events received after this timestamp.",
        },
      },
    },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/webhook-events${qs(args)}`, undefined, ctx),
  },
  {
    name: "webhook_events.get",
    description:
      "Fetch one webhook event including the full raw_body. Returns 404 if the event id is unknown.",
    scope: "read",
    annotations: {
      title: "Get webhook event",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string", description: "Webhook event id." } },
    },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/webhook-events/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "openapi.get",
    description:
      "Fetch the OpenAPI 3.1 description of /api/v1. Use this to discover REST surfaces not yet wrapped as MCP tools.",
    scope: "read",
    annotations: {
      title: "OpenAPI document",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", additionalProperties: false },
    dispatch: (_args, ctx) => callV1("GET", "/openapi.json", undefined, ctx),
  },
];

const ApiTokenScopesForCall = ApiTokenCreateSchema.shape.scopes;

// Resolve which scopes a bearer token holds so we can filter the tool
// list per-caller. We re-use the existing bearer auth path by routing
// a HEAD-like request through the internal v1 router; if it returns
// 401, no token. Otherwise we pull the scopes from the api_tokens row.
async function lookupScopes(ctx: DispatchCtx): Promise<Scope[] | null> {
  // Cheap proxy: dispatch GET /api/v1/api-tokens. It requires `read`
  // and returns 401/403 if the token is bad / lacks scope. We extract
  // the scope set from the response when 200; otherwise fall through
  // to looking up the row directly via DB.
  const token = parseBearer(ctx.authorization);
  if (!token) return null;
  const { hashToken } = await import("../lib/auth/bearer");
  const hash = await hashToken(token);
  const row = await ctx.env.DB.prepare(
    "SELECT scopes FROM api_tokens WHERE token_hash = ?",
  )
    .bind(hash)
    .first<{ scopes: string | null }>()
    .catch(() => null);
  if (!row) return null;
  const parsed = ApiTokenScopesForCall.safeParse(
    row.scopes ? JSON.parse(row.scopes) : [],
  );
  return parsed.success ? (parsed.data as Scope[]) : [];
}

function parseBearer(header: string): string | null {
  const m = /^Bearer\s+(.+)$/.exec(header.trim());
  return m?.[1] ?? null;
}

function filterTools(tools: Tool[], scopes: Scope[] | null): Tool[] {
  if (!scopes) return [];
  const set = new Set(scopes);
  return tools.filter((t) => set.has(t.scope) || set.has("admin"));
}

function ok(id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(
  id: JsonRpcResponse["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

// Build the unified result envelope used for both v1-mapped errors and
// internal exceptions, so agents see one shape.
function toolResultEnvelope(
  status: number,
  body: unknown,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  structuredContent: unknown;
  _meta: { http_status: number };
} {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    isError: status >= 400,
    structuredContent: body,
    _meta: { http_status: status },
  };
}

function negotiateProtocolVersion(requested: unknown): string {
  if (
    typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

export function buildMcpRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/mcp", async (c) => {
    const authorization =
      c.req.header("authorization") ?? c.req.header("Authorization");
    if (!authorization || !extractBearer(c)) {
      return respondError(c, "unauthorized", "MCP requires a bearer token.");
    }

    const body = (await c.req.json().catch(() => null)) as
      | JsonRpcRequest
      | null;
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return c.json(err(null, ERR.InvalidRequest, "Malformed JSON-RPC request."));
    }
    const id = body.id ?? null;

    const dispatchCtx: DispatchCtx = {
      env: c.env,
      exec: c.executionCtx,
      authorization,
    };

    if (body.method === "ping") {
      return c.json(ok(id, {}));
    }

    if (body.method === "initialize") {
      const requested = (body.params as { protocolVersion?: unknown } | undefined)
        ?.protocolVersion;
      return c.json(
        ok(id, {
          protocolVersion: negotiateProtocolVersion(requested),
          serverInfo: {
            name: "symphony-linear-agent",
            version: "1.0.0",
          },
          capabilities: { tools: { listChanged: false } },
        }),
      );
    }

    if (body.method === "tools/list") {
      const scopes = await lookupScopes(dispatchCtx);
      if (!scopes)
        return c.json(err(id, ERR.InvalidRequest, "Unknown or revoked bearer token."));
      const tools = filterTools(TOOLS, scopes).map((t) => {
        const out: Record<string, unknown> = {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        };
        if (t.outputSchema) out.outputSchema = t.outputSchema;
        if (t.annotations) out.annotations = t.annotations;
        return out;
      });
      return c.json(ok(id, { tools }));
    }

    if (body.method === "tools/call") {
      const params = (body.params ?? {}) as {
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof params.name !== "string")
        return c.json(err(id, ERR.InvalidParams, "Missing tool name."));
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool)
        return c.json(err(id, ERR.MethodNotFound, `No such tool: ${params.name}`));

      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};

      try {
        const result = await tool.dispatch(args, dispatchCtx);
        const projected = tool.projectResult
          ? tool.projectResult(result.body)
          : result.body;
        return c.json(ok(id, toolResultEnvelope(result.status, projected)));
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown_tool_error";
        const body = { error: "internal_error", message };
        return c.json(ok(id, toolResultEnvelope(500, body)));
      }
    }

    return c.json(err(id, ERR.MethodNotFound, `Unknown method: ${body.method}`));
  });

  return app;
}
