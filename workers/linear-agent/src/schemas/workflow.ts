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

// Body schema for `POST /api/v1/workflows`. The server applies scope
// (org/team/user id, version=1, status=draft, timestamps) from the
// auth context so we don't accept those columns in the body.
//
// `prompt_template` is required at the DB level (NOT NULL), and the
// API layer matches that — a workflow without a template can't run.
export const WorkflowCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),

  engine: engineSchema.default("pi"),
  model: z.string().nullable().optional(),
  max_turns: z.number().int().positive().default(10),
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
  hook_timeout_ms: z.number().int().nonnegative().default(300000),

  prompt_template: z.string().min(1),
});
export type WorkflowCreateInput = z.infer<typeof WorkflowCreateSchema>;

// Update — all fields optional. Bumping `version` / flipping `status`
// goes through dedicated routes (`publish`, `duplicate`), not PUT.
export const WorkflowUpdateSchema = WorkflowCreateSchema.partial();
export type WorkflowUpdateInput = z.infer<typeof WorkflowUpdateSchema>;
