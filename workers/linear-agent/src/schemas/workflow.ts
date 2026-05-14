// Workflow schemas (SYM-295).
//
// The DB shape mirrors migrations/0002_workflows.sql exactly — JSON
// columns are kept as TEXT in storage and serialized arrays/objects in
// the wire/Zod shape. The resolver and API layers parse JSON columns
// on read; the API layer stringifies on write.
//
// Scope tier — exactly one of organization_id / team_id / user_id is
// non-null on every row. The DB enforces this with a CHECK. The
// `WorkflowSchema` mirrors that invariant via a refinement so client
// code can rely on it (the resolver also derives `scope_tier` from
// these columns).

import { z } from "zod";

export const workflowStatusSchema = z.enum(["draft", "published", "archived"]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

// Engine identifiers match the sandbox-dispatcher profile names.
// Strings (not a closed enum) so adding a new engine doesn't require
// a Worker deploy — the dispatcher rejects unknown engines at runtime.
export const engineSchema = z.string().min(1);
export type Engine = z.infer<typeof engineSchema>;

// Permission mode — kept open-string (not a closed enum) to match how
// Codex / Claude Code engines extend the surface; bad values fail at
// the dispatcher.
export const permissionModeSchema = z.string();

// MCP server record stored inside the `mcp_servers` JSON column.
export const mcpServerSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

// Full workflow row — the resolver, API responses, and version
// snapshots all use this shape. JSON-column fields are surfaced as
// parsed arrays/objects; the DB layer is responsible for stringify/
// parse at the boundary.
export const WorkflowSchema = z
  .object({
    id: z.string(),

    organization_id: z.string().nullable(),
    team_id: z.string().nullable(),
    user_id: z.string().nullable(),

    name: z.string().min(1),
    description: z.string().nullable().optional(),

    engine: engineSchema,
    model: z.string().nullable().optional(),
    max_turns: z.number().int().positive(),
    max_continuations: z.number().int().nonnegative().nullable().optional(),

    allowed_tools: z.array(z.string()).nullable().optional(),
    disallowed_tools: z.array(z.string()).nullable().optional(),
    allowed_domains: z.array(z.string()).nullable().optional(),
    mcp_servers: z.array(mcpServerSchema).nullable().optional(),
    permission_mode: permissionModeSchema.nullable().optional(),
    additional_read_paths: z.array(z.string()).nullable().optional(),
    additional_write_paths: z.array(z.string()).nullable().optional(),

    hook_after_create: z.string().nullable().optional(),
    hook_before_remove: z.string().nullable().optional(),
    hook_timeout_ms: z.number().int().nonnegative(),

    prompt_template: z.string(),

    version: z.number().int().positive(),
    status: workflowStatusSchema,
    published_at: z.number().int().nullable().optional(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .superRefine((wf, ctx) => {
    const scopeCount =
      (wf.organization_id ? 1 : 0) +
      (wf.team_id ? 1 : 0) +
      (wf.user_id ? 1 : 0);
    if (scopeCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "exactly one of organization_id, team_id, user_id must be non-null",
        path: ["organization_id"],
      });
    }
  });
export type Workflow = z.infer<typeof WorkflowSchema>;

// Shared field shapes — no defaults, no required wrappers. The Create
// schema layers defaults + required-ness on top; the Update schema
// uses these as-is so an absent field stays absent (instead of being
// resolved to a default and overwriting the live row's value).
const workflowFieldShapes = {
  name: z.string().min(1),
  description: z.string().nullable().optional(),

  engine: engineSchema,
  model: z.string().nullable().optional(),
  max_turns: z.number().int().positive(),
  max_continuations: z.number().int().nonnegative().nullable().optional(),

  allowed_tools: z.array(z.string()).nullable().optional(),
  disallowed_tools: z.array(z.string()).nullable().optional(),
  allowed_domains: z.array(z.string()).nullable().optional(),
  mcp_servers: z.array(mcpServerSchema).nullable().optional(),
  permission_mode: permissionModeSchema.nullable().optional(),
  additional_read_paths: z.array(z.string()).nullable().optional(),
  additional_write_paths: z.array(z.string()).nullable().optional(),

  hook_after_create: z.string().nullable().optional(),
  hook_before_remove: z.string().nullable().optional(),
  hook_timeout_ms: z.number().int().nonnegative(),

  prompt_template: z.string().min(1),
};

const unsupportedRuntimePolicyFields = [
  "allowed_domains",
  "mcp_servers",
  "additional_read_paths",
  "additional_write_paths",
  "hook_after_create",
  "hook_before_remove",
] as const;

function hasRuntimePolicyValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "string" || value.trim().length > 0;
}

export function unsupportedRuntimePolicyIssues(
  input: Record<string, unknown>,
): Array<{ path: string[]; message: string }> {
  return unsupportedRuntimePolicyFields
    .filter((field) => hasRuntimePolicyValue(input[field]))
    .map((field) => ({
      path: [field],
      message:
        "runtime policy field is not supported by dispatched sessions yet",
    }));
}

// Body schema for `POST /api/v1/workflows`. The server applies scope
// (org/team/user id, version=1, status=draft, timestamps) from the
// auth context so we don't accept those columns in the body.
//
// `prompt_template` is required at the DB level (NOT NULL), and the
// API layer matches that — a workflow without a template can't run.
// Runtime policy fields are intentionally split: dispatcher-supported
// fields (`allowed_tools`, `disallowed_tools`, `permission_mode`) are
// accepted and plumbed into runs; unsupported policy-looking fields are
// rejected instead of being stored and silently ignored.
export const WorkflowCreateSchema = z.object({
  ...workflowFieldShapes,
  engine: workflowFieldShapes.engine.default("pi"),
  max_turns: workflowFieldShapes.max_turns.default(10),
  hook_timeout_ms: workflowFieldShapes.hook_timeout_ms.default(300000),
});
export type WorkflowCreateInput = z.infer<typeof WorkflowCreateSchema>;

// Update — all fields optional, NO defaults. Bare `.partial()` on the
// Create schema would keep the `.default(...)` annotations, so an
// absent `engine` would still resolve to "pi" and the route would
// overwrite the live row's engine. We build Update from the raw shapes
// instead.
export const WorkflowUpdateSchema = z.object(workflowFieldShapes).partial();
export type WorkflowUpdateInput = z.infer<typeof WorkflowUpdateSchema>;
