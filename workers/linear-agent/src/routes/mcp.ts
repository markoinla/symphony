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

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../index";
import { extractBearer } from "../lib/auth/bearer";
import { respondError } from "../lib/responses";
import { ApiTokenCreateSchema } from "../schemas/api-token";
import { ProjectCreateSchema, ProjectUpdateSchema } from "../schemas/project";
import { TriggerCreateSchema, TriggerUpdateSchema } from "../schemas/trigger";
import {
  WorkflowCreateSchema,
  WorkflowUpdateSchema,
} from "../schemas/workflow";
import { buildApiV1Router } from "./api-v1";

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

interface Tool {
  name: string;
  description: string;
  scope: Scope;
  inputSchema: Record<string, unknown>;
  // Dispatch an MCP `tools/call` invocation into the v1 REST surface.
  // Returns the JSON body (object) plus the response status so the
  // MCP envelope can carry both.
  dispatch: (args: Record<string, unknown>, ctx: DispatchCtx) => Promise<DispatchResult>;
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
// Tool registry — 1:1 with the v1 routes per docs/linear_agent_api_v1.md.
// Token CRUD is intentionally absent: agents shouldn't issue agent
// credentials.
// ────────────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "workflows.list",
    description: "List workflows in the calling token's org. Cursor paginated.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        before_id: { type: "string" },
        status: { type: "string", enum: ["draft", "published", "archived"] },
      },
    },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/workflows${qs(args)}`, undefined, ctx),
  },
  {
    name: "workflows.get",
    description: "Get a workflow by id.",
    scope: "read",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/workflows/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "workflows.create",
    description: "Create a new workflow in the calling token's org.",
    scope: "write",
    inputSchema: z.toJSONSchema(WorkflowCreateSchema),
    dispatch: (args, ctx) => callV1("POST", "/api/v1/workflows", args, ctx),
  },
  {
    name: "workflows.update",
    description: "Update a workflow. Only `draft` workflows are editable.",
    scope: "write",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, patch: z.toJSONSchema(WorkflowUpdateSchema) },
    },
    dispatch: (args, ctx) =>
      callV1(
        "PUT",
        `/api/v1/workflows/${encId(args.id)}`,
        (args.patch ?? {}) as Record<string, unknown>,
        ctx,
      ),
  },
  {
    name: "workflows.delete",
    description: "Delete a workflow.",
    scope: "write",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("DELETE", `/api/v1/workflows/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "workflows.publish",
    description: "Snapshot a workflow + flip its status to `published`.",
    scope: "write",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("POST", `/api/v1/workflows/${encId(args.id)}/publish`, undefined, ctx),
  },
  {
    name: "workflows.duplicate",
    description: "Duplicate a workflow (returns a new draft).",
    scope: "write",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("POST", `/api/v1/workflows/${encId(args.id)}/duplicate`, undefined, ctx),
  },
  {
    name: "workflows.preview",
    description: "Render a workflow's prompt template against an issue.",
    scope: "read",
    inputSchema: {
      type: "object",
      required: ["id", "issue_id"],
      properties: { id: { type: "string" }, issue_id: { type: "string" } },
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
    description: "List triggers for a workflow.",
    scope: "read",
    inputSchema: { type: "object", required: ["workflow_id"], properties: { workflow_id: { type: "string" } } },
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
    description: "Create a trigger on a workflow.",
    scope: "write",
    inputSchema: {
      type: "object",
      required: ["workflow_id", "trigger"],
      properties: {
        workflow_id: { type: "string" },
        trigger: z.toJSONSchema(TriggerCreateSchema),
      },
    },
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
    description: "Get a trigger by id.",
    scope: "read",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/triggers/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "triggers.update",
    description: "Update a trigger.",
    scope: "write",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, patch: z.toJSONSchema(TriggerUpdateSchema) },
    },
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
    description: "Delete a trigger.",
    scope: "write",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("DELETE", `/api/v1/triggers/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "projects.list",
    description: "List projects in the calling token's org.",
    scope: "read",
    inputSchema: { type: "object" },
    dispatch: (_args, ctx) => callV1("GET", "/api/v1/projects", undefined, ctx),
  },
  {
    name: "projects.get",
    description: "Get a project by id.",
    scope: "read",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/projects/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "projects.create",
    description: "Create a project. Returns 409 if (org, linear_team_id) already exists.",
    scope: "write",
    inputSchema: z.toJSONSchema(ProjectCreateSchema),
    dispatch: (args, ctx) => callV1("POST", "/api/v1/projects", args, ctx),
  },
  {
    name: "projects.update",
    description: "Update a project.",
    scope: "write",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, patch: z.toJSONSchema(ProjectUpdateSchema) },
    },
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
    description: "Delete a project.",
    scope: "write",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("DELETE", `/api/v1/projects/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "settings.list",
    description: "List settings + agent_defaults.",
    scope: "read",
    inputSchema: { type: "object" },
    dispatch: (_args, ctx) => callV1("GET", "/api/v1/settings", undefined, ctx),
  },
  {
    name: "settings.get",
    description: "Get a single setting by key.",
    scope: "read",
    inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/settings/${encId(args.key)}`, undefined, ctx),
  },
  {
    name: "settings.set",
    description: "Upsert a setting.",
    scope: "write",
    inputSchema: {
      type: "object",
      required: ["key", "value"],
      properties: { key: { type: "string" }, value: { type: "string" } },
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
    description: "Delete a setting.",
    scope: "write",
    inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("DELETE", `/api/v1/settings/${encId(args.key)}`, undefined, ctx),
  },
  {
    name: "integrations.status",
    description: "Connected-status payload for every provider.",
    scope: "read",
    inputSchema: { type: "object" },
    dispatch: (_args, ctx) =>
      callV1("GET", "/api/v1/integrations", undefined, ctx),
  },
  {
    name: "webhook_events.list",
    description: "List webhook deliveries (cursor paginated).",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        before_id: { type: "string" },
        envelope: { type: "string" },
        dispatched_action: { type: "string" },
        signature_ok: { type: "boolean" },
        deduped: { type: "boolean" },
        since_ts: { type: "integer" },
      },
    },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/webhook-events${qs(args)}`, undefined, ctx),
  },
  {
    name: "webhook_events.get",
    description: "Get one webhook event (full raw_body).",
    scope: "read",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    dispatch: (args, ctx) =>
      callV1("GET", `/api/v1/webhook-events/${encId(args.id)}`, undefined, ctx),
  },
  {
    name: "openapi.get",
    description: "Fetch the OpenAPI 3.1 description of /api/v1.",
    scope: "read",
    inputSchema: { type: "object" },
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
      return c.json(
        ok(id, {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "symphony-linear-agent",
            version: "1.0.0",
          },
          capabilities: { tools: {} },
        }),
      );
    }

    if (body.method === "tools/list") {
      const scopes = await lookupScopes(dispatchCtx);
      if (!scopes)
        return c.json(err(id, ERR.InvalidRequest, "Unknown or revoked bearer token."));
      const tools = filterTools(TOOLS, scopes).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
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
        const isError = result.status >= 400;
        return c.json(
          ok(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(result.body),
              },
            ],
            isError,
            structuredContent: result.body,
            _meta: { http_status: result.status },
          }),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown_tool_error";
        return c.json(err(id, ERR.ToolError, msg));
      }
    }

    return c.json(err(id, ERR.MethodNotFound, `Unknown method: ${body.method}`));
  });

  return app;
}
