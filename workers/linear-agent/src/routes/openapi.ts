// OpenAPI 3.1 document for /api/v1/*.
//
// Hand-composed paths × Zod-derived component schemas. We use Zod 4's
// built-in `z.toJSONSchema()` rather than `@hono/zod-openapi` so we
// can keep the existing route definitions unchanged — adding the doc
// costs a single mount, not a per-route rewrite.
//
// Consumers:
//   - MCP shim (src/routes/mcp.ts) reads `paths` + `components.schemas`
//     to materialize tool input/output shapes.
//   - External clients that want a stable JSON contract.
//
// Keep in sync with docs/linear_agent_api_v1.md when you add routes.

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../index";
import { ApiTokenCreateSchema, ApiTokenSchema } from "../schemas/api-token";
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
  WorkflowSchema,
  WorkflowUpdateSchema,
} from "../schemas/workflow";

const ErrorEnvelope = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.array(z.unknown()).optional(),
});

const Cursor = z.string().nullable();

const SettingSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const IntegrationsSchema = z.object({
  linear: z.object({ connected: z.boolean() }),
  github: z.object({
    connected: z.boolean(),
    repo_selection: z.string().nullable(),
    repo_count: z.number().nullable(),
  }),
  anthropic: z.object({ configured: z.boolean() }),
  openai: z.object({ configured: z.boolean() }),
  cf_workers_ai: z.object({ configured: z.boolean() }),
  github_app_settings_url: z.string().nullable(),
});

const WebhookEventSchema = z.object({
  id: z.string(),
  received_at: z.number().int(),
  organization_id: z.string().nullable(),
  envelope_type: z.string(),
  envelope_action: z.string().nullable(),
  signature_ok: z.boolean(),
  deduped: z.boolean(),
  dispatched_action: z.string().nullable(),
  agent_session_id: z.string().nullable(),
  error: z.string().nullable(),
  latency_ms: z.number().int(),
  raw_body: z.string().nullable(),
  raw_body_truncated: z.boolean().optional(),
});

// Each Zod schema → JSON Schema component. `z.toJSONSchema` is Zod 4
// native; output is a Draft-2020-12 JSON Schema.
const components = {
  schemas: {
    ErrorEnvelope:        z.toJSONSchema(ErrorEnvelope),
    Workflow:             z.toJSONSchema(WorkflowSchema),
    WorkflowCreateInput:  z.toJSONSchema(WorkflowCreateSchema),
    WorkflowUpdateInput:  z.toJSONSchema(WorkflowUpdateSchema),
    Trigger:              z.toJSONSchema(TriggerSchema),
    TriggerCreateInput:   z.toJSONSchema(TriggerCreateSchema),
    TriggerUpdateInput:   z.toJSONSchema(TriggerUpdateSchema),
    Project:              z.toJSONSchema(ProjectSchema),
    ProjectCreateInput:   z.toJSONSchema(ProjectCreateSchema),
    ProjectUpdateInput:   z.toJSONSchema(ProjectUpdateSchema),
    ApiToken:             z.toJSONSchema(ApiTokenSchema),
    ApiTokenCreateInput:  z.toJSONSchema(ApiTokenCreateSchema),
    Setting:              z.toJSONSchema(SettingSchema),
    Integrations:         z.toJSONSchema(IntegrationsSchema),
    WebhookEvent:         z.toJSONSchema(WebhookEventSchema),
  },
  securitySchemes: {
    bearer: {
      type: "http",
      scheme: "bearer",
      description: "Token issued via POST /api/v1/api-tokens.",
    },
    cookie: {
      type: "apiKey",
      in: "cookie",
      name: "better-auth.session_token",
      description: "Browser session — Better Auth dashboard login.",
    },
  },
} as const;

const ref = (name: keyof typeof components.schemas) => ({
  $ref: `#/components/schemas/${name}`,
});

const jsonBody = (name: keyof typeof components.schemas) => ({
  content: { "application/json": { schema: ref(name) } },
});

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ref("ErrorEnvelope") } },
});

// Standard responses every route shares.
const commonErrors = {
  "400": errorResponse("Validation failed."),
  "401": errorResponse("Unauthorized — missing or invalid credentials."),
  "403": errorResponse("Forbidden — missing required scope."),
  "404": errorResponse("Not found."),
};

const cursorListResponse = (
  itemSchema: keyof typeof components.schemas,
  itemsKey: string,
) => ({
  "200": {
    description: "OK",
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: [itemsKey],
          properties: {
            [itemsKey]: { type: "array", items: ref(itemSchema) },
            next_cursor: z.toJSONSchema(Cursor),
          },
        },
      },
    },
  },
});

const paginationParams = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
  {
    name: "before_id",
    in: "query",
    schema: { type: "string" },
  },
];

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  schema: { type: "string", maxLength: 200 },
  description:
    "Client-supplied unique key. The first response is cached for 24h; replays return the same body with `Idempotent-Replayed: true`.",
};

export function buildOpenApiDocument(env: Env): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Symphony linear-agent API",
      version: "1.0.0",
      description:
        "REST surface for managing workflows, triggers, projects, settings, and API tokens. See docs/linear_agent_api_v1.md for the design spec.",
    },
    servers: [{ url: env.URL ?? "https://agent.example" }],
    security: [{ bearer: [] }, { cookie: [] }],
    components,
    paths: {
      "/api/v1/workflows": {
        get: {
          summary: "List workflows (cursor paginated)",
          parameters: [
            ...paginationParams,
            { name: "status", in: "query", schema: { type: "string", enum: ["draft", "published", "archived"] } },
            { name: "team_id", in: "query", schema: { type: "string" } },
            { name: "user_id", in: "query", schema: { type: "string" } },
          ],
          responses: cursorListResponse("Workflow", "workflows"),
        },
        post: {
          summary: "Create a workflow",
          parameters: [idempotencyHeader],
          requestBody: jsonBody("WorkflowCreateInput"),
          responses: {
            "201": { description: "Created", ...jsonBody("Workflow") },
            ...commonErrors,
          },
        },
      },
      "/api/v1/workflows/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Get workflow", responses: { "200": { description: "OK", ...jsonBody("Workflow") }, ...commonErrors } },
        put: {
          summary: "Update workflow (draft only)",
          requestBody: jsonBody("WorkflowUpdateInput"),
          responses: {
            "200": { description: "OK", ...jsonBody("Workflow") },
            "409": errorResponse("Workflow is not in `draft` status."),
            ...commonErrors,
          },
        },
        delete: { summary: "Delete workflow", responses: { "200": { description: "OK" }, ...commonErrors } },
      },
      "/api/v1/workflows/{id}/publish": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Publish workflow", responses: { "200": { description: "OK" }, ...commonErrors } },
      },
      "/api/v1/workflows/{id}/duplicate": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: {
          summary: "Duplicate workflow",
          parameters: [idempotencyHeader],
          responses: { "201": { description: "Created", ...jsonBody("Workflow") }, ...commonErrors },
        },
      },
      "/api/v1/workflows/{id}/preview": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: {
          summary: "Render the prompt template against an issue",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", required: ["issue_id"], properties: { issue_id: { type: "string" } } },
              },
            },
          },
          responses: { "200": { description: "OK" }, ...commonErrors },
        },
      },
      "/api/v1/workflows/{id}/triggers": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          summary: "List triggers for a workflow",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { triggers: { type: "array", items: ref("Trigger") } },
                  },
                },
              },
            },
            ...commonErrors,
          },
        },
        post: {
          summary: "Create trigger",
          parameters: [idempotencyHeader],
          requestBody: jsonBody("TriggerCreateInput"),
          responses: { "201": { description: "Created", ...jsonBody("Trigger") }, ...commonErrors },
        },
      },
      "/api/v1/triggers/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Get trigger", responses: { "200": { description: "OK", ...jsonBody("Trigger") }, ...commonErrors } },
        put: {
          summary: "Update trigger",
          requestBody: jsonBody("TriggerUpdateInput"),
          responses: { "200": { description: "OK", ...jsonBody("Trigger") }, ...commonErrors },
        },
        delete: { summary: "Delete trigger", responses: { "200": { description: "OK" }, ...commonErrors } },
      },
      "/api/v1/projects": {
        get: {
          summary: "List projects",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { projects: { type: "array", items: ref("Project") } } },
                },
              },
            },
            ...commonErrors,
          },
        },
        post: {
          summary: "Create project (strict, no upsert)",
          parameters: [idempotencyHeader],
          requestBody: jsonBody("ProjectCreateInput"),
          responses: {
            "201": { description: "Created", ...jsonBody("Project") },
            "409": errorResponse("A project for this (org, linear_team_id) already exists."),
            ...commonErrors,
          },
        },
      },
      "/api/v1/projects/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Get project", responses: { "200": { description: "OK", ...jsonBody("Project") }, ...commonErrors } },
        put: {
          summary: "Update project",
          requestBody: jsonBody("ProjectUpdateInput"),
          responses: { "200": { description: "OK", ...jsonBody("Project") }, ...commonErrors },
        },
        delete: { summary: "Delete project", responses: { "200": { description: "OK" }, ...commonErrors } },
      },
      "/api/v1/settings": {
        get: { summary: "List settings + agent_defaults", responses: { "200": { description: "OK" }, ...commonErrors } },
      },
      "/api/v1/settings/{key}": {
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Get setting", responses: { "200": { description: "OK", ...jsonBody("Setting") }, ...commonErrors } },
        put: {
          summary: "Upsert setting",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
              },
            },
          },
          responses: { "200": { description: "OK", ...jsonBody("Setting") }, ...commonErrors },
        },
        delete: { summary: "Delete setting", responses: { "200": { description: "OK" }, ...commonErrors } },
      },
      "/api/v1/integrations": {
        get: { summary: "Connected-status payload for every provider", responses: { "200": { description: "OK", ...jsonBody("Integrations") }, ...commonErrors } },
      },
      "/api/v1/api-tokens": {
        get: {
          summary: "List API tokens (no plaintext)",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { tokens: { type: "array", items: ref("ApiToken") } } },
                },
              },
            },
            ...commonErrors,
          },
        },
        post: {
          summary: "Mint a new API token. Plaintext returned exactly once.",
          requestBody: jsonBody("ApiTokenCreateInput"),
          responses: { "201": { description: "Created" }, ...commonErrors },
        },
      },
      "/api/v1/api-tokens/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        delete: { summary: "Revoke API token", responses: { "200": { description: "OK" }, ...commonErrors } },
      },
      "/api/v1/webhook-events": {
        get: {
          summary: "List webhook deliveries (cursor paginated)",
          parameters: [
            ...paginationParams,
            { name: "envelope", in: "query", schema: { type: "string" } },
            { name: "dispatched_action", in: "query", schema: { type: "string" } },
            { name: "signature_ok", in: "query", schema: { type: "boolean" } },
            { name: "deduped", in: "query", schema: { type: "boolean" } },
            { name: "since_ts", in: "query", schema: { type: "integer" } },
          ],
          responses: cursorListResponse("WebhookEvent", "webhook_events"),
        },
      },
      "/api/v1/webhook-events/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Get a single webhook event (full raw_body)", responses: { "200": { description: "OK" }, ...commonErrors } },
      },
    },
  };
}

export function buildOpenApiRouter() {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument(c.env)));
  return app;
}
